'use strict';

// Boutique et inventaire du jeu sur la page « Mon compte » — donc dans l'app iOS
// installée depuis le site.
//
// Tout passe par le site (`/api/game/inventory`, `/api/game/storefront`, `/api/game/buy`) :
// le navigateur n'envoie jamais de prix, ni de pseudo de jeu. Le serveur relit le catalogue,
// applique la seule remise existante (REC BLUE Plus, 10 %) et débite le solde du jeu.
//
// Un achat se confirme en deux temps : le premier appui arme le bouton et rappelle le prix,
// le second achète. C'est ce qui évite les achats accidentels sur un écran de téléphone.

(function () {
  const config = window.RECBLUE_ACCOUNTS || {};
  const PAGE = 40;
  const byId = id => document.getElementById(id);

  let client = null;
  let started = false;
  let currency = null;

  const state = {
    storefront: 3,
    items: [], // catalogue de la boutique affichée
    catalogs: new Map(),
    wardrobe: [],
    query: '',
    wardrobeQuery: '',
    shown: PAGE,
    wardrobeShown: PAGE,
    armed: null // `${storefront}:${item}` du bouton en attente de confirmation
  };

  const credits = () => (typeof currency === 'number' ? currency : null);

  function money(value) {
    if (typeof value !== 'number') return '—';
    return value.toLocaleString('fr-FR');
  }

  async function token() {
    if (!client) return '';
    const { data } = await client.auth.getSession();
    return data && data.session ? data.session.access_token : '';
  }

  async function api(path, init) {
    const access = await token();
    if (!access) return { status: 401, body: null };
    const options = Object.assign({}, init || {});
    options.headers = Object.assign({ Authorization: 'Bearer ' + access }, options.headers || {});
    options.cache = 'no-store';
    const response = await fetch(path, options).catch(() => null);
    if (!response) return { status: 0, body: null };
    const body = await response.json().catch(() => null);
    return { status: response.status, body };
  }

  function setCredits(value) {
    if (typeof value !== 'number') return;
    currency = value;
    const target = byId('credits-balance');
    if (target) target.textContent = money(value);
  }

  function status(message) {
    const box = byId('boutique-status');
    if (box) box.textContent = message || '';
  }

  function itemCell(kind, entry) {
    const li = document.createElement('li');
    li.className = 'item' + (entry.owned ? ' is-owned' : '');

    const name = document.createElement('strong');
    name.className = 'item-name';
    name.textContent = entry.name || 'Article sans nom';
    li.appendChild(name);

    if (kind === 'shop') {
      const meta = document.createElement('div');
      meta.className = 'item-meta';
      if (entry.plusOnly) {
        const tag = document.createElement('span');
        tag.className = 'tag plus';
        tag.textContent = 'Plus seulement';
        meta.appendChild(tag);
      }
      if (entry.box) {
        const tag = document.createElement('span');
        tag.className = 'tag';
        tag.textContent = 'Boîte surprise';
        meta.appendChild(tag);
      }
      if (meta.childNodes.length > 0) li.appendChild(meta);

      const price = document.createElement('span');
      price.className = 'item-price';
      price.textContent = money(entry.price) + ' ';
      const unit = document.createElement('small');
      unit.textContent = 'crédits';
      price.appendChild(unit);
      li.appendChild(price);

      if (entry.owned) {
        const owned = document.createElement('span');
        owned.className = 'item-owned';
        owned.textContent = 'Déjà à vous';
        li.appendChild(owned);
      } else {
        const buy = document.createElement('button');
        buy.className = 'btn';
        buy.type = 'button';
        buy.textContent = 'Acheter';
        buy.dataset.key = state.storefront + ':' + entry.id;
        buy.addEventListener('click', () => onBuy(entry, buy));
        li.appendChild(buy);
      }
    } else {
      const meta = document.createElement('div');
      meta.className = 'item-meta';
      const rarity = document.createElement('span');
      rarity.textContent = 'Rareté ' + (typeof entry.rarity === 'number' ? entry.rarity : '—');
      meta.appendChild(rarity);
      li.appendChild(meta);
    }

    return li;
  }

  function renderWardrobe() {
    const list = byId('wardrobe-list');
    if (!list) return;
    const query = state.wardrobeQuery;
    const found = query
      ? state.wardrobe.filter(item => (item.name || '').toLowerCase().includes(query))
      : state.wardrobe;

    list.textContent = '';
    for (const entry of found.slice(0, state.wardrobeShown)) {
      list.appendChild(itemCell('wardrobe', entry));
    }

    const more = byId('wardrobe-more');
    if (more) more.hidden = found.length <= state.wardrobeShown;

    const note = byId('wardrobe-note');
    if (note) {
      note.textContent =
        found.length === 0
          ? 'Aucun objet ne correspond.'
          : found.length + (found.length > 1 ? ' objets' : ' objet') + ' dans votre inventaire.';
    }
  }

  function renderShop() {
    const list = byId('boutique-list');
    if (!list) return;
    const query = state.query;
    const found = query
      ? state.items.filter(item => (item.name || '').toLowerCase().includes(query))
      : state.items;

    list.textContent = '';
    for (const entry of found.slice(0, state.shown)) {
      list.appendChild(itemCell('shop', entry));
    }

    const more = byId('boutique-more');
    if (more) more.hidden = found.length <= state.shown;
  }

  async function loadInventory() {
    const result = await api('/api/game/inventory');
    if (result.status === 401) {
      show(false);
      return;
    }
    if (result.status !== 200 || !result.body) {
      const note = byId('wardrobe-note');
      if (note) note.textContent = (result.body && result.body.error) || 'Inventaire indisponible pour le moment.';
      return;
    }
    state.wardrobe = Array.isArray(result.body.items) ? result.body.items : [];
    setCredits(result.body.credits);
    renderWardrobe();
  }

  async function loadCatalog(storefront) {
    const loading = byId('boutique-loading');
    if (loading) loading.textContent = 'Chargement de la boutique…';
    state.items = [];
    renderShop();

    const result = await api('/api/game/storefront?storefront=' + encodeURIComponent(storefront));
    if (loading) loading.textContent = '';
    if (result.status === 401) {
      show(false);
      return;
    }
    if (result.status !== 200 || !result.body) {
      status((result.body && result.body.error) || 'Boutique indisponible pour le moment.');
      return;
    }

    state.items = Array.isArray(result.body.items) ? result.body.items : [];
    if (state.catalogs.get(storefront) === undefined) state.catalogs.set(storefront, state.items);
    setCredits(result.body.credits);
    state.shown = PAGE;
    renderShop();
  }

  async function onBuy(entry, button) {
    const key = state.storefront + ':' + entry.id;

    // Premier appui : on arme le bouton et on annonce le prix. Second appui : on achète.
    if (state.armed !== key) {
      state.armed = key;
      button.dataset.label = button.textContent;
      button.textContent = 'Confirmer · ' + money(entry.price) + ' crédits';
      status('Appuyez une seconde fois pour acheter « ' + (entry.name || 'cet article') + ' ».');
      window.setTimeout(() => {
        if (state.armed !== key) return;
        state.armed = null;
        button.textContent = button.dataset.label || 'Acheter';
      }, 6000);
      return;
    }

    state.armed = null;
    button.disabled = true;
    button.textContent = 'Achat en cours…';
    status('');

    const result = await api('/api/game/buy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ storefront: state.storefront, item: entry.id })
    });

    button.disabled = false;
    button.textContent = button.dataset.label || 'Acheter';

    if (result.status !== 200 || !result.body) {
      const message = (result.body && result.body.error) || 'L’achat n’a pas abouti.';
      status(message);
      return;
    }

    const name = (result.body.item && result.body.item.name) || entry.name || 'Article';
    const paid = typeof result.body.charged === 'number' ? result.body.charged : entry.price;
    setCredits(result.body.credits);
    status(
      'Acheté : ' + name + ' — ' + money(paid) + ' crédits. La boîte apparaîtra dans le jeu.'
    );
    entry.owned = true;

    // L'objet rejoint l'inventaire affiché, et le bouton devient « Déjà à vous ».
    state.wardrobe.unshift({ name: name, rarity: null });
    state.wardrobe.sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'fr'));
    state.wardrobeShown = Math.max(state.wardrobeShown, PAGE);
    renderWardrobe();
    renderShop();
  }

  function show(loggedIn) {
    const wardrobe = byId('wardrobe-card');
    const shop = byId('boutique-card');
    if (wardrobe) wardrobe.hidden = !loggedIn;
    if (shop) shop.hidden = !loggedIn;
    if (!loggedIn) {
      state.wardrobe = [];
      state.items = [];
      status('');
    }
  }

  async function start() {
    if (started) return;
    started = true;
    show(true);

    const tabs = byId('boutique-tabs');
    if (tabs) {
      tabs.addEventListener('click', event => {
        const button = event.target.closest('button[data-storefront]');
        if (!button) return;
        const storefront = Number(button.dataset.storefront);
        if (!Number.isInteger(storefront) || storefront === state.storefront) return;
        for (const tab of tabs.querySelectorAll('button[data-storefront]')) {
          const on = tab === button;
          tab.classList.toggle('is-on', on);
          tab.setAttribute('aria-selected', on ? 'true' : 'false');
        }
        state.storefront = storefront;
        state.query = '';
        const search = byId('boutique-search');
        if (search) search.value = '';
        state.armed = null;
        const cached = state.catalogs.get(storefront);
        if (cached) {
          state.items = cached;
          state.shown = PAGE;
          renderShop();
        } else {
          loadCatalog(storefront);
        }
      });
    }

    const shopSearch = byId('boutique-search');
    if (shopSearch) {
      shopSearch.addEventListener('input', () => {
        state.query = shopSearch.value.trim().toLowerCase();
        state.shown = PAGE;
        renderShop();
      });
    }

    const wardrobeSearch = byId('wardrobe-search');
    if (wardrobeSearch) {
      wardrobeSearch.addEventListener('input', () => {
        state.wardrobeQuery = wardrobeSearch.value.trim().toLowerCase();
        state.wardrobeShown = PAGE;
        renderWardrobe();
      });
    }

    const shopMore = byId('boutique-more');
    if (shopMore) {
      shopMore.addEventListener('click', () => {
        state.shown += PAGE;
        renderShop();
      });
    }

    const wardrobeMore = byId('wardrobe-more');
    if (wardrobeMore) {
      wardrobeMore.addEventListener('click', () => {
        state.wardrobeShown += PAGE;
        renderWardrobe();
      });
    }

    await Promise.all([loadInventory(), loadCatalog(state.storefront)]);
  }

  function boot() {
    if (!window.supabase || !window.supabase.createClient || !config.supabaseUrl) return;
    client = window.supabase.createClient(config.supabaseUrl, config.publishableKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
    });

    client.auth.getSession().then(({ data }) => {
      if (data && data.session) start();
      else show(false);
    });

    client.auth.onAuthStateChange((_event, session) => {
      if (session) start();
      else show(false);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
