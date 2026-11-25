(() => {
  const byId = id => document.getElementById(id);
  const status = byId('shop-status');
  const say = text => { if (status) status.textContent = text; };
  const config = window.RECBLUE_ACCOUNTS || {};
  // Même session que le site : supabase-js range le jeton sous sb-<projet>-auth-token.
  const projectRef = (() => { try { return new URL(config.supabaseUrl).hostname.split('.')[0]; } catch { return ''; } })();
  const client = window.supabase && config.supabaseUrl && projectRef
    ? window.supabase.createClient(config.supabaseUrl, config.publishableKey, { auth: { storageKey: 'sb-' + projectRef + '-auth-token', autoRefreshToken: false, detectSessionInUrl: false } })
    : null;
  const ONE_TIME = new Set(['pplus', 'pstarter']);
  const defaultLabels = new WeakMap();

  async function token() {
    if (!client) return '';
    const { data } = await client.auth.getSession();
    return (data && data.session && data.session.access_token) || '';
  }

  function rememberLabels() {
    document.querySelectorAll('[data-pack]').forEach(button => {
      if (!defaultLabels.has(button)) defaultLabels.set(button, button.textContent);
    });
  }

  function setOneTimeState(claims) {
    document.querySelectorAll('[data-pack]').forEach(button => {
      const pack = button.getAttribute('data-pack');
      if (!ONE_TIME.has(pack)) return;
      const already = Boolean(claims && claims[pack]);
      button.textContent = already ? 'Déjà obtenu' : (defaultLabels.get(button) || 'Obtenir');
      button.disabled = already;
    });
  }

  async function refreshOneTimeState() {
    if (!client) return;
    try {
      const { data: sessionData } = await client.auth.getSession();
      if (!sessionData || !sessionData.session) {
        setOneTimeState({});
        return;
      }
      const { data } = await client.auth.getUser();
      const metadata = data && data.user && data.user.user_metadata;
      const claims = metadata && metadata.recblue_free_claims;
      setOneTimeState(claims && typeof claims === 'object' && !Array.isArray(claims) ? claims : {});
    } catch {
      /* L’état sera confirmé au moment du clic. */
    }
  }

  function formatHistoryDate(value) {
    try {
      return new Intl.DateTimeFormat('fr-FR', {
        day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'
      }).format(new Date(value));
    } catch {
      return '';
    }
  }

  function renderHistory(items) {
    const section = byId('shop-history');
    const list = byId('shop-history-list');
    if (!section || !list) return;
    list.replaceChildren();
    if (!Array.isArray(items) || items.length === 0) {
      section.hidden = true;
      return;
    }
    for (const item of items.slice(0, 6)) {
      const li = document.createElement('li');
      li.className = 'shop-history-item';
      const copy = document.createElement('span');
      const name = document.createElement('strong');
      name.textContent = String(item.name || 'Réclamation');
      const date = document.createElement('span');
      date.className = 'shop-history-date';
      date.textContent = formatHistoryDate(item.at);
      copy.append(name, date);
      const amount = document.createElement('span');
      amount.className = 'shop-history-credits';
      const credits = Number(item.credits) || 0;
      amount.textContent = credits > 0 ? '+' + formatCredits(credits) + ' crédits' : '';
      li.append(copy, amount);
      list.append(li);
    }
    section.hidden = false;
  }

  async function loadHistory(accessToken) {
    if (!accessToken) {
      renderHistory([]);
      return;
    }
    try {
      const response = await fetch('api/shop/history', {
        headers: { Authorization: 'Bearer ' + accessToken },
        cache: 'no-store'
      });
      const data = await response.json().catch(() => ({}));
      renderHistory(response.ok && Array.isArray(data.history) ? data.history : []);
    } catch {
      renderHistory([]);
    }
  }

  window.addEventListener('recblue:auth', async () => {
    try {
      await refreshOneTimeState();
      await loadHistory(await token());
    } catch {}
  });

  async function call(payload, accessToken) {
    const response = await fetch('api/shop/claim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + accessToken },
      body: JSON.stringify(payload)
    });
    const data = await response.json().catch(() => ({}));
    return { ok: response.ok, status: response.status, data };
  }

  // La pastille garde sa pièce : on ne remplace que le texte du solde.
  function creditsLabel(pill) {
    if (!pill) return null;
    if (!pill.querySelector('img.nav-coin')) {
      const coin = document.createElement('img');
      coin.className = 'nav-coin';
      coin.src = 'credits-coin.svg';
      coin.alt = '';
      coin.width = 15;
      coin.height = 15;
      coin.setAttribute('aria-hidden', 'true');
      pill.prepend(coin);
    }
    let label = byId('nav-credits-value');
    if (!label) {
      label = document.createElement('span');
      label.id = 'nav-credits-value';
      pill.appendChild(label);
    }
    return label;
  }

  // Séparateur de milliers VISIBLE : l'espace fine de fr-FR (U+202F) est invisible dans
  // la police d'affichage du site, ce qui collait les gros soldes (« 4635662 »).
  function formatCredits(value) {
    return String(Math.round(Number(value) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  }

  function showBalance(total) {
    const value = Number(total) || 0;
    const pill = byId('nav-credits');
    if (pill) {
      const text = formatCredits(value) + (value === 1 ? ' crédit' : ' crédits');
      const label = creditsLabel(pill);
      if (label) label.textContent = text;
      pill.hidden = false;
    }
    const card = byId('credits-balance');
    if (card) card.textContent = formatCredits(value);
  }

  async function refreshBalance(accessToken) {
    const response = await fetch('api/game/credits', {
      headers: { Authorization: 'Bearer ' + accessToken },
      cache: 'no-store'
    });
    if (!response.ok) return null;
    const data = await response.json().catch(() => null);
    const credits = data && typeof data.credits === 'number' ? data.credits : null;
    if (credits !== null) showBalance(credits);
    return credits;
  }

  function formatDate(value) {
    try {
      return new Intl.DateTimeFormat('fr-FR', { dateStyle: 'long' }).format(new Date(value));
    } catch {
      return String(value);
    }
  }

  async function claim(pack, button) {
    const accessToken = await token();
    if (accessToken) await refreshOneTimeState();
    if (!accessToken) {
      say('Connectez-vous d’abord : ouvrez « Mon compte REC BLUE » pour obtenir ce pack gratuit.');
      const dialog = byId('connexion');
      if (dialog && !dialog.open) dialog.showModal();
      const field = byId('login-identifier');
      if (field) field.focus();
      return;
    }

    const label = button.textContent;
    button.disabled = true;
    button.textContent = 'Ajout…';
    say('Ajout du pack gratuit…');
    try {
      const { ok, data } = await call({ pack }, accessToken);
      if (!ok) throw new Error(data.error || 'Le pack gratuit n’est pas disponible pour le moment.');

      if (data.alreadyClaimed) {
        say('Ce pack gratuit a déjà été obtenu sur ce compte.');
        button.textContent = 'Déjà obtenu';
        button.disabled = true;
        return;
      }

      if (typeof data.credits === 'number') showBalance(data.credits);
      else await refreshBalance(accessToken);

      const added = Number(data.added) || 0;
      if (data.plusUntil) {
        const creditsLine = data.inGame === true
          ? ' et ' + formatCredits(added) + ' crédits ajoutés.'
          : '. Le serveur de jeu n’a pas confirmé les crédits.';
        say('REC BLUE Plus offert jusqu’au ' + formatDate(data.plusUntil) + creditsLine);
      } else {
        say(formatCredits(added) + (added === 1 ? ' crédit gratuit ajouté.' : ' crédits gratuits ajoutés.'));
      }
      if (data.warning) say((status && status.textContent ? status.textContent + ' ' : '') + data.warning);

      if (ONE_TIME.has(pack)) {
        button.textContent = 'Obtenu ✓';
        button.disabled = true;
      } else {
        button.textContent = defaultLabels.get(button) || 'Obtenir';
        button.disabled = false;
      }
      loadHistory(accessToken);
    } catch (error) {
      say(error.message || 'Pack gratuit impossible pour le moment.');
      button.disabled = false;
      button.textContent = label;
    }
  }  document.addEventListener('click', event => {
    const button = event.target.closest('[data-pack]');
    if (!button) return;

    event.preventDefault();
    claim(button.getAttribute('data-pack'), button);
  });

  // Recharge l'historique à chaque ouverture de la boutique : le login a pu être
  // fait après le chargement de la page.
  document.addEventListener('click', event => {
    if (!event.target.closest('[data-dialog="boutique"]')) return;
    setTimeout(async () => {
      try {
        await refreshOneTimeState();
        await loadHistory(await token());
      } catch {}
    }, 0);
  });

  function initOneTimeState() {
    rememberLabels();
    refreshOneTimeState();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initOneTimeState);
  else initOneTimeState();
})();
