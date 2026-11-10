(() => {
  const byId = id => document.getElementById(id);
  const msg = byId('msg');
  const config = window.RECBLUE_ACCOUNTS;
  const PSEUDO_DOMAIN = 'players.recblue.invalid';
  const PSEUDO_PATTERN = /^[a-z0-9_][a-z0-9_-]{2,19}$/;
  const labels = { member: 'Membre', moderator: 'Modérateur', admin: 'Administrateur' };
  let client = null;
  let user = null;
  let profile = null;
  let revision = 0;
  let factors = { totp: [], phone: [] };
  let pendingFactorId = '';
  let phoneChallengeId = '';
  const say = text => { msg.textContent = text; };
  const pseudoOf = email => {
    const value = String(email || '').toLowerCase();
    const suffix = '@' + PSEUDO_DOMAIN;
    return value.endsWith(suffix) ? value.slice(0, -suffix.length) : '';
  };
  const readPref = (key, fallback) => { try { return localStorage.getItem(key) ?? fallback; } catch (error) { return fallback; } };
  const savePref = (key, value) => { try { localStorage.setItem(key, value); } catch (error) { /* stockage indisponible */ } };
  const initials = name => String(name || '?').trim().slice(0, 2).toUpperCase();
  const AVATAR_PATTERN = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;
  // La photo du JEU arrive sous forme d'URL (service d'images), pas en data URL : elle doit
  // être acceptée ici aussi, sinon l'avatar retombait sur les initiales alors qu'elle existait.
  const GAME_AVATAR_PATTERN = /^https:\/\/img\.recblue\.net\/[^\s"'<>]+$/;
  const isAvatarUrl = value =>
    typeof value === 'string' && (AVATAR_PATTERN.test(value) || GAME_AVATAR_PATTERN.test(value));
  // La photo du JEU (servie par le service d'images) a la priorité : c'est celle que le
  // joueur voit dans Rec Room, le site montre donc la même.
  let gameImage = '';
  // Bannière du jeu : même source que la photo, le pont renvoie les deux ensemble.
  let gameBanner = '';
  async function gameAvatar() {
    try {
      const token = await sessionToken();
      if (!token) return { image: '', banner: '' };
      const response = await fetch('/api/game/avatar', { headers: { Authorization: 'Bearer ' + token }, cache: 'no-store' });
      const body = await response.json().catch(() => null);
      if (!response.ok || !body) return { image: '', banner: '' };
      return {
        image: typeof body.image === 'string' ? body.image : '',
        banner: typeof body.banner === 'string' ? body.banner : ''
      };
    } catch (error) { return { image: '', banner: '' }; }
  }
  function applyAvatar() {
    const element = byId('avatar');
    const siteUrl = isAvatarUrl(profile?.avatar_url) ? profile.avatar_url : '';
    const url = gameImage || siteUrl;
    if (isAvatarUrl(url)) {
      element.style.backgroundImage = 'url("' + url + '")';
      element.textContent = '';
      element.classList.add('has-photo');
      byId('avatar-remove').hidden = false;
    } else {
      element.style.backgroundImage = '';
      element.textContent = initials(profile?.display_name);
      element.classList.remove('has-photo');
      byId('avatar-remove').hidden = true;
    }
    // Bannière du jeu (la grande image du profil Rec Room), quand le joueur en a une.
    const banner = byId('banner');
    if (banner) {
      const show = GAME_AVATAR_PATTERN.test(gameBanner || '');
      banner.hidden = !show;
      banner.style.backgroundImage = show ? 'url("' + gameBanner + '")' : '';
    }
  }
  async function prepareAvatar(file) {
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) throw new Error('Format accepté : JPG, PNG ou WebP.');
    if (file.size > 5 * 1024 * 1024) throw new Error('Image trop lourde : 5 Mo maximum.');
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error('Image illisible.'));
      reader.readAsDataURL(file);
    });
    const image = await new Promise((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error('Image illisible.'));
      element.src = dataUrl;
    });
    const size = 160;
    const canvas = document.createElement('canvas');
    canvas.width = size; canvas.height = size;
    const context = canvas.getContext('2d');
    const side = Math.min(image.width, image.height);
    context.drawImage(image, (image.width - side) / 2, (image.height - side) / 2, side, side, 0, 0, size, size);
    return canvas.toDataURL('image/jpeg', 0.82);
  }
  const formatDate = value => {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString('fr-FR', { day: '2-digit', month: 'long', year: 'numeric' });
  };
  const isLifetime = value => {
    const date = new Date(value);
    return !Number.isNaN(date.getTime()) && date.getUTCFullYear() >= 9000;
  };
  async function guard(button, action) {
    if (button) button.disabled = true;
    try { await action(); } catch (error) { say(error.message || 'Action impossible. Réessayez.'); }
    finally { if (button) button.disabled = false; }
  }

  async function needsMfa() {
    const { data, error } = await client.auth.mfa.getAuthenticatorAssuranceLevel();
    if (error) return false;
    return data.currentLevel === 'aal1' && data.nextLevel === 'aal2';
  }
  function renderFactors() {
    const active = [...factors.totp, ...factors.phone];
    byId('mfa-state').textContent = active.length ? 'Protection : mot de passe + code à 6 chiffres.' : 'Protection : mot de passe seul.';
    if (!active.length) { byId('mfa-factors').textContent = 'Aucune double authentification active.'; return; }
    const fragment = document.createDocumentFragment();
    active.forEach(factor => {
      const row = document.createElement('div'); row.className = 'user';
      const label = document.createElement('span');
      label.textContent = factor.factor_type === 'totp' ? 'Application d’authentification' : 'SMS ' + (factor.phone || '');
      const remove = document.createElement('button');
      remove.type = 'button'; remove.className = 'btn ghost'; remove.textContent = 'Désactiver';
      remove.addEventListener('click', () => guard(remove, async () => {
        const { error } = await client.auth.mfa.unenroll({ factorId: factor.id });
        if (error) throw new Error('Désactivation impossible. Réessayez.');
        say('Double authentification désactivée pour ce facteur.');
        await loadFactors();
      }));
      row.append(label, remove); fragment.append(row);
    });
    byId('mfa-factors').replaceChildren(fragment);
  }
  async function loadFactors() {
    const { data, error } = await client.auth.mfa.listFactors();
    if (error) throw error;
    const all = data.all || [];
    factors = {
      totp: all.filter(factor => factor.factor_type === 'totp' && factor.status === 'verified'),
      phone: all.filter(factor => factor.factor_type === 'phone' && factor.status === 'verified')
    };
    renderFactors();
    applyMfaPolicy();
  }
  // Politique : la double authentification est obligatoire pour tous les comptes.
  function applyMfaPolicy() {
    const required = factors.totp.length + factors.phone.length === 0;
    document.body.classList.toggle('mfa-required', required);
    const alert = byId('mfa-alert');
    if (alert) alert.hidden = !required;
  }
  function showGate() {
    byId('guest').hidden = true; byId('member').hidden = true;
    byId('gate').hidden = false;
    byId('gate-code').value = '';
    byId('gate-send').hidden = factors.totp.length > 0;
    byId('gate-factors').textContent = factors.totp.length
      ? 'Ouvrez votre application d’authentification et saisissez le code affiché.'
      : (factors.phone.length ? 'Appuyez sur « Recevoir un code par SMS » puis saisissez le code reçu.' : 'Aucun facteur disponible : contactez un administrateur.');
  }
  // Le solde montré ici est celui du JEU : un seul nombre pour le site et le jeu.
  async function sessionToken() {
    const { data } = await client.auth.getSession();
    return data && data.session ? data.session.access_token : '';
  }
  async function gameCredits() {
    try {
      const token = await sessionToken();
      if (!token) return null;
      const response = await fetch('/api/game/credits', { headers: { Authorization: 'Bearer ' + token }, cache: 'no-store' });
      if (!response.ok) return null;
      const body = await response.json();
      return typeof body.credits === 'number' ? body.credits : null;
    } catch (error) { return null; }
  }
  // Plus et bannissement : la décision est prise ici, le compte de JEU la reçoit.
  // Le badge « Certifié REC BLUE » vit sur le compte de JEU : on le lit, on ne le déduit pas.
  async function gameStatus() {
    try {
      const token = await sessionToken();
      if (!token) return { certified: false, plus: false, role: '' };
      const response = await fetch('/api/game/certified', { headers: { Authorization: 'Bearer ' + token } });
      const body = await response.json().catch(() => null);
      const rang = body && (body.role === 'admin' || body.role === 'moderator') ? body.role : '';
      return {
        certified: !!(response.ok && body && body.certified),
        plus: !!(response.ok && body && body.plus),
        role: rang
      };
    } catch (error) { return { certified: false, plus: false, role: '' }; }
  }
  async function gameRequest(path, payload) {
    try {
      const token = await sessionToken();
      if (!token) return { ok: false, error: 'session absente' };
      const response = await fetch(path, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) return { ok: false, error: (body && body.error) || ('statut ' + response.status) };
      return body || { ok: true };
    } catch (error) { return { ok: false, error: 'réseau' }; }
  }
  // Crée le compte de JEU avec le pseudo et le mot de passe du site. Utilisé à
  // l'inscription, puis par le bouton de réparation des comptes créés avant le pont.
  async function activateGameAccount(pseudo, password) {
    try {
      const token = await sessionToken();
      if (!token) return { ok: false, error: 'session absente' };
      const response = await fetch('/api/game/signup', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ pseudo, password })
      });
      const body = await response.json().catch(() => null);
      if (!response.ok || !body || !body.ok) {
        return { ok: false, error: (body && body.error) || ('statut ' + response.status) };
      }
      return body;
    } catch (error) { return { ok: false, error: 'réseau' }; }
  }
  async function grantGame(target, amount) {
    try {
      const token = await sessionToken();
      if (!token) return { ok: false, error: 'session absente' };
      const response = await fetch('/api/game/grant', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ target, tokens: amount })
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) return { ok: false, error: (body && body.error) || ('statut ' + response.status) };
      return body || { ok: true };
    } catch (error) { return { ok: false, error: 'réseau' }; }
  }
  function showGuest() {
    user = null; profile = null;
    byId('member').hidden = true;
    byId('guest').hidden = false;
  }
  // Séparateur de milliers VISIBLE : l'espace fine de fr-FR (U+202F) est invisible dans
  // la police d'affichage du site, ce qui collait les gros soldes (« 4635662 »).
  function formatCredits(value) {
    return String(Math.round(Number(value) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  }
  async function loadProfile() {
    const current = ++revision;
    const { data, error } = await client.auth.getUser();
    if (current !== revision) return;
    if (error || !data.user) { showGuest(); return; }
    user = data.user;
    try {
      const soldeJeu = await gameCredits();
      const secours = await client.from('recblue_accounts').select('credits').eq('id', user.id).single();
      const montant = formatCredits(soldeJeu === null ? (Number(secours.data?.credits) || 0) : soldeJeu) + ' crédits';
      const gateSolde = byId('gate-credits');
      if (gateSolde) gateSolde.textContent = 'Solde actuel : ' + montant;
    } catch (error) { /* solde indisponible */ }
    if (await needsMfa()) {
      try { await loadFactors(); } catch (error) { /* liste 2FA indisponible */ }
      showGate();
      return;
    }
    const result = await client.from('recblue_accounts').select('id,display_name,role,created_at,avatar_url,contact_email,credits,plus_until').eq('id', user.id).single();
    if (current !== revision) return;
    if (result.error) { showGuest(); say('Profil inaccessible. Vérifiez la configuration SQL.'); return; }
    profile = result.data;
    const pseudo = pseudoOf(user.email);
    const jeu = await gameAvatar();
    gameImage = jeu.image;
    gameBanner = jeu.banner;
    if (current !== revision) return;
    byId('guest').hidden = true;
    byId('member').hidden = false;
    applyAvatar();
    byId('side-name').textContent = profile.display_name;
    const solde = byId('credits-balance');
    if (solde) {
      const soldeJeu = await gameCredits();
      solde.textContent = formatCredits(soldeJeu === null ? (Number(profile.credits) || 0) : soldeJeu);
    }
    byId('side-login').textContent = pseudo ? '@' + pseudo : (user.email || '—');
    // L'état du JEU apporte le cadre doré, le pseudo en or, le logo RB Plus et la
    // certification. Le RÔLE affiché, lui, est celui du site : c'est la seule autorité,
    // sinon un rôle retiré depuis ce site continuerait de s'afficher.
    const etatJeu = await gameStatus();
    const roleEffectif = profile.role;
    const role = byId('side-role');
    role.textContent = labels[roleEffectif] || 'Droit inconnu';
    role.className = 'badge' + (roleEffectif === 'admin' ? ' admin' : roleEffectif === 'moderator' ? ' mod' : '');
    // Le Plus peut venir du site (Supabase) ou du compte de JEU : les deux comptent.
    const plus = (!!profile.plus_until && new Date(profile.plus_until).getTime() > Date.now()) || etatJeu.plus;
    byId('side-name').classList.toggle('plus-name', plus);
    // Membre REC BLUE Plus : le solde de crédits passe en or.
    const creditsLine = document.querySelector('.credits-balance');
    if (creditsLine) creditsLine.classList.toggle('plus-credits', plus);
    const sideMark = byId('side-plus-mark');
    if (sideMark) sideMark.hidden = !plus;
    byId('side-login').classList.toggle('plus-name', plus);
    // Cadre doré de la photo de profil pour les membres REC BLUE Plus.
    byId('avatar').classList.toggle('plus-ring', plus);
    const plusBadge = byId('side-plus');
    if (plusBadge) {
      plusBadge.hidden = !plus;
      if (plus) plusBadge.textContent = isLifetime(profile.plus_until) ? 'REC BLUE Plus · à vie' : 'REC BLUE Plus · ' + formatDate(profile.plus_until);
    }
    const certBadge = byId('side-certified');
    if (certBadge) certBadge.hidden = !etatJeu.certified;
    byId('side-created').textContent = formatDate(profile.created_at);
    byId('side-id').textContent = String(user.id).slice(0, 8) + '…';
    byId('side-email').textContent = profile.contact_email || '—';
    byId('contact-email').value = profile.contact_email || '';
    byId('name').value = profile.display_name;
    byId('admin').hidden = !(profile.role === 'admin' || profile.role === 'moderator');
    byId('admin-users').replaceChildren();
    try { await loadFactors(); } catch (error) { byId('mfa-state').textContent = 'État de la double authentification indisponible.'; }
  }

  // Personnalisation : couleur d'accent du site, propre à ce navigateur.
  (function setupAccents() {
    const box = byId('accents');
    const theme = window.recblueTheme;
    if (!box || !theme) return;
    const draw = () => {
      const current = theme.current();
      box.replaceChildren(...Object.entries(theme.accents).map(([name, color]) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'accent' + (name === current ? ' active' : '');
        button.style.background = color;
        button.setAttribute('aria-label', 'Couleur ' + name);
        button.setAttribute('aria-pressed', name === current ? 'true' : 'false');
        button.addEventListener('click', () => { theme.set(name); draw(); });
        return button;
      }));
    };
    draw();
    const reset = byId('accent-reset');
    if (reset) reset.addEventListener('click', () => { theme.set('bleu'); draw(); });
  })();

  /**
   * Change le rôle d'un compte. Le Worker du site l'écrit en base avec la clé de service
   * (et répercute le rôle en jeu) ; si ce chemin échoue, la RPC SQL est retentée pour ne
   * dépendre d'aucun des deux seul.
   */
  async function setSiteRole(account, role) {
    const viaWorker = await gameRequest('/api/game/site-role', {
      id: account.id,
      role,
      target: account.display_name
    }).catch(() => null);
    // Le Worker répond maintenant même quand la fiche du site refuse : il indique alors
    // lequel des deux côtés a cédé, au lieu de laisser croire que rien n'a été tenté.
    if (viaWorker && viaWorker.site) return viaWorker;
    const { error } = await client.rpc('recblue_set_role', { target_id: account.id, new_role: role });
    if (error) {
      throw new Error((viaWorker && viaWorker.error) || error.message || 'Changement de rôle refusé.');
    }
    const game = await gameRequest('/api/game/role', { target: account.display_name, role }).catch(() => null);
    return { ok: true, role, game };
  }

  async function listUsers() {
    const result = await client.from('recblue_accounts').select('id,display_name,role,created_at').order('created_at', { ascending: false }).limit(100);
    if (result.error) throw result.error;
    const rows = result.data;
    const fragment = document.createDocumentFragment();
    rows.forEach(account => {
      const row = document.createElement('div'); row.className = 'user';
      const info = document.createElement('span');
      info.textContent = account.display_name;
      const meta = document.createElement('small');
      meta.textContent = formatDate(account.created_at) + ' · ' + (labels[account.role] || account.role);
      info.append(meta);
      const select = document.createElement('select');
      select.setAttribute('aria-label', 'Droits de ' + account.display_name);
      Object.entries(labels).forEach(([value, label]) => {
        const option = document.createElement('option'); option.value = value; option.textContent = label; select.append(option);
      });
      select.value = account.role;
      const apply = document.createElement('button');
      apply.type = 'button'; apply.className = 'btn ghost'; apply.textContent = 'Appliquer';
      // Un modérateur voit la liste mais ne change pas les droits.
      const isAdmin = profile?.role === 'admin';
      select.disabled = !isAdmin; apply.disabled = !isAdmin; apply.hidden = !isAdmin;
      apply.addEventListener('click', () => guard(apply, async () => {
        // Un seul aller-retour : le Worker écrit le rôle du site (clé de service, sur
        // l'identifiant du compte) puis le rôle de jeu. La RPC SQL seule échouait sans
        // bruit dès que la base n'acceptait pas encore « moderator ».
        const synced = await setSiteRole(account, select.value);
        const label = labels[select.value] || select.value;
        const game = synced.game || {};
        const site = synced.site || {};
        if (site.ok && game.ok) say('Droits de ' + account.display_name + ' : ' + label + ' sur le site ET en jeu (effectif à la prochaine connexion du joueur).');
        else if (!game.ok) say('Rôle du site : ' + (site.ok ? label : 'refusé') + '. En jeu, le rôle n’a pas suivi : ' + (game.error || 'serveur de jeu injoignable') + '.');
        else say('Rôle de jeu passé à ' + label + ', mais la fiche du site a refusé : ' + (site.error || 'erreur inconnue') + '.');
        await loadProfile();
        if (profile?.role === 'admin') await listUsers();
      }));
      // Le badge « Certifié REC BLUE » : accordé par l’administration, rangé sur le compte de jeu.
      const certify = document.createElement('button');
      certify.type = 'button'; certify.className = 'btn ghost'; certify.textContent = 'Certifier';
      certify.disabled = !isAdmin; certify.hidden = !isAdmin;
      certify.addEventListener('click', () => guard(certify, async () => {
        const on = certify.dataset.certified !== '1';
        const result = await gameRequest('/api/game/certify', { target: account.display_name, certified: on });
        if (!result || !result.ok) throw new Error((result && result.error) || 'Certification refusée.');
        certify.dataset.certified = on ? '1' : '0';
        certify.textContent = on ? 'Retirer la certification' : 'Certifier';
        say((on ? 'Compte certifié : ' : 'Certification retirée : ') + account.display_name + '.');
      }));
      row.append(info, select, apply, certify);
      fragment.append(row);
    });
    byId('admin-users').replaceChildren(fragment);
  }

  byId('login').addEventListener('submit', event => {
    event.preventDefault();
    guard(event.submitter, async () => {
      const identifier = byId('login-id').value.trim();
      const password = byId('login-pw').value;
      byId('login-pw').value = '';
      let email = identifier;
      if (!identifier.includes('@')) {
        const pseudo = identifier.toLowerCase();
        if (!PSEUDO_PATTERN.test(pseudo)) throw new Error('Pseudo invalide : 3 à 20 lettres, chiffres, tiret ou souligné.');
        email = pseudo + '@' + PSEUDO_DOMAIN;
      }
      let attempt;
      try {
        attempt = await client.auth.signInWithPassword({ email, password });
      } catch (failure) {
        throw new Error('Le site n’a pas pu joindre le service de comptes (' + ((failure && failure.message) || 'réseau bloqué') + '). Vérifiez votre connexion internet, coupez un VPN ou un bloqueur de publicité, puis réessayez.');
      }
      const { error } = attempt;
      if (error) {
        const code = String(error.code || error.name || '');
        const detail = String(error.message || '');
        if (error.status === 429 || code === 'over_request_rate_limit' || /rate limit/i.test(detail)) throw new Error('Trop de tentatives de connexion : patientez une minute et réessayez.');
        if (code === 'email_not_confirmed' || /email not confirmed/i.test(detail)) throw new Error('L’email de ce compte n’a jamais été confirmé : connectez-vous avec le pseudo, ou demandez à un administrateur.');
        if (/aal|mfa|totp|factor/i.test(code + ' ' + detail)) throw new Error('Ce compte exige un code de double authentification : saisissez-le ci-dessous.');
        if (code === 'invalid_credentials' || /invalid login credentials/i.test(detail)) throw new Error('Mot de passe incorrect, ou aucun compte sous « ' + email + ' ».');
        if (!navigator.onLine || !error.status || /fetch|network|timeout/i.test(code + ' ' + detail)) {
          throw new Error(!navigator.onLine
            ? 'Ce navigateur est hors connexion : rétablissez internet puis réessayez.'
            : 'Le site n’a pas pu joindre le service de comptes (' + (detail || code || 'réseau bloqué') + '). Vérifiez internet, coupez un VPN ou un bloqueur de publicité, puis réessayez.');
        }
        throw new Error('Connexion refusée par le service (' + (code || 'sans code') + ', statut ' + (error.status || 'inconnu') + ') : ' + (detail || 'réessayez dans un instant.'));
      }
      say((await needsMfa()) ? 'Mot de passe accepté : saisissez votre code de double authentification.' : 'Connexion réussie.');
      await loadProfile();
    });
  });

  byId('signup').addEventListener('submit', event => {
    event.preventDefault();
    guard(event.submitter, async () => {
      const pseudo = byId('signup-pseudo').value.trim().toLowerCase();
      const password = byId('signup-pw').value;
      byId('signup-pw').value = '';
      if (!/^[a-z0-9]{3,20}$/.test(pseudo)) throw new Error('Pour jouer, choisis un pseudo de 3 à 20 lettres ou chiffres, sans tiret ni souligné.');
      const availability = await fetch('/api/game/username-availability?pseudo=' + encodeURIComponent(pseudo));
      const availabilityData = await availability.json().catch(() => null);
      if (!availability.ok || !availabilityData) throw new Error('Impossible de vérifier le pseudo en jeu. Réessaie plus tard.');
      if (!availabilityData.available) throw new Error('Ce pseudo existe déjà dans le jeu. Choisis-en un autre.');
      const { data, error } = await client.auth.signUp({ email: pseudo + '@' + PSEUDO_DOMAIN, password });
      if (error) {
        if (error.code === 'user_already_exists' || /already/i.test(error.message || '')) throw new Error('Ce pseudo est déjà pris.');
        if (error.code === 'over_email_send_rate_limit' || /rate limit/i.test(error.message || '')) throw new Error('Trop d’inscriptions coup sur coup : réessayez dans quelques minutes.');
        if (error.code === 'weak_password' || /password/i.test(error.message || '')) throw new Error('Mot de passe refusé : choisissez-en un d’au moins 12 caractères.');
        throw new Error('Inscription impossible : ' + (error.message || 'service indisponible.'));
      }
      if (!data.session) throw new Error('Inscription non activée : la confirmation email de Supabase doit être désactivée.');
      await client.from('recblue_accounts').update({ display_name: pseudo }).eq('id', data.user.id).select('id').single();
      // Le compte du JEU, avec le même pseudo et le même mot de passe : c'est ce qui permet
      // de se connecter dans Rec Room juste après l'inscription sur le site.
      let gameNote = '';
      const game = await activateGameAccount(pseudo, password);
      if (game.ok) {
        gameNote = game.renamed
          ? ' Ton compte de jeu est prêt : connecte-toi dans Rec Room avec « ' + pseudo + ' » et ce mot de passe.' + (game.linked ? '' : ' La liaison sécurisée n’a pas pu être enregistrée ; contacte un administrateur.')
          : ' Compte de jeu créé, mais ' + (game.warning || 'le pseudo en jeu n’a pas pu être appliqué.') + ' Réessaie depuis Mon espace compte si besoin.';
      } else {
        gameNote = ' Compte de jeu non créé : ' + (game.error || 'serveur de jeu indisponible') + ' — tu peux réessayer depuis Mon espace compte.';
      }
      say('Compte créé avec le rôle membre.' + gameNote);
      await loadProfile();
    });
  });

  // Réparation des comptes créés avant l'appel automatique au pont du jeu.
  byId('game-account').addEventListener('submit', event => {
    event.preventDefault();
    guard(byId('game-create'), async () => {
      if (!user || !profile) throw new Error('Connecte-toi avant d’activer le compte de jeu.');
      const password = byId('game-password').value;
      byId('game-password').value = '';
      if (password.length < 8) throw new Error('Le mot de passe du site doit contenir au moins 8 caractères.');
      const pseudo = pseudoOf(user.email) || String(profile.display_name || '').trim().toLowerCase();
      if (!/^[a-z0-9]{3,20}$/.test(pseudo)) {
        throw new Error('Pseudo de jeu invalide : 3 à 20 lettres ou chiffres, sans tiret ni souligné. Contacte un administrateur pour ton compte existant.');
      }
      const result = await activateGameAccount(pseudo, password);
      if (!result.ok) throw new Error('Compte de jeu non créé : ' + (result.error || 'serveur de jeu indisponible.'));
      const text = result.renamed
        ? 'Compte de jeu prêt : connecte-toi dans Rec Room avec « ' + pseudo + ' » et ce mot de passe.' + (result.linked ? '' : ' La liaison sécurisée n’a pas pu être enregistrée ; contacte un administrateur.')
        : 'Compte de jeu créé, mais ' + (result.warning || 'le pseudo en jeu n’a pas pu être appliqué.') + ' Utilise le pseudo indiqué par le jeu.';
      byId('game-status').textContent = text;
      say(text);
      await loadProfile();
    });
  });

  byId('profile').addEventListener('submit', event => {
    event.preventDefault();
    guard(event.submitter, async () => {
      if (!profile) throw new Error('Profil indisponible.');
      const name = byId('name').value.trim();
      if (name.length < 2 || name.length > 40) throw new Error('Le pseudo doit contenir entre 2 et 40 caractères.');
      const { data, error } = await client.from('recblue_accounts').update({ display_name: name }).eq('id', profile.id).select('id').single();
      if (error || !data) throw new Error('Modification refusée. Reconnectez-vous et réessayez.');
      say('Pseudo enregistré.');
      await loadProfile();
    });
  });

  byId('password').addEventListener('submit', event => {
    event.preventDefault();
    guard(event.submitter, async () => {
      const first = byId('new-pw').value;
      const second = byId('new-pw2').value;
      byId('new-pw').value = ''; byId('new-pw2').value = '';
      if (first.length < 12) throw new Error('Le mot de passe doit contenir au moins 12 caractères.');
      if (first !== second) throw new Error('Les deux mots de passe ne sont pas identiques.');
      const { error } = await client.auth.updateUser({ password: first });
      if (error) throw new Error('Changement refusé : ' + (error.message || 'réessayez.'));
      say('Mot de passe du site modifié. Le mot de passe du jeu ne change pas automatiquement.');
    });
  });

  byId('logout').addEventListener('click', () => guard(byId('logout'), async () => {
    const { error } = await client.auth.signOut({ scope: 'local' });
    if (error) throw new Error('Déconnexion impossible.');
    ++revision;
    showGuest();
    say('Vous êtes déconnecté.');
  }));

  byId('admin-refresh').addEventListener('click', () => guard(byId('admin-refresh'), listUsers));

  // REC BLUE Plus : date de fin choisie par un administrateur.
  byId('admin-plus')?.addEventListener('submit', event => {
    event.preventDefault();
    guard(byId('admin-plus-submit'), async () => {
      if (profile?.role !== 'admin') throw new Error('Accès administrateur requis.');
      const target = byId('admin-plus-target').value.trim();
      if (!target) throw new Error('Indiquez un pseudo ou une adresse email.');
      const day = byId('admin-plus-date').value;
      if (!day) throw new Error('Choisissez la date de fin du REC BLUE Plus.');
      const until = new Date(day + 'T23:59:59');
      if (until.getTime() <= Date.now()) throw new Error('La date de fin doit être dans le futur.');
      // Le jeu d'abord : la fiche du site est facultative, un joueur peut n'exister qu'en jeu.
      // Le Worker écrit la date en base avec la clé de service ET sur le compte de jeu.
      const jeu = await gameRequest('/api/game/site-plus', { target, until: until.toISOString() }).catch(() => null);
      if (!(jeu && jeu.ok)) {
        const site = await client.rpc('recblue_grant_plus', { p_identifier: target, p_until: until.toISOString() });
        if (site.error) throw site.error;
      }
      byId('admin-plus-date').value = '';
      say(jeu && jeu.ok
        ? 'REC BLUE Plus accordé à ' + target + ' jusqu’au ' + formatDate(until) + ', actif dans le jeu.'
        : 'REC BLUE Plus accordé côté site jusqu’au ' + formatDate(until) + ', mais le jeu n’a pas suivi' + (jeu && jeu.error ? ' : ' + jeu.error : '.') + '.');
      await loadProfile();
    });
  });

  byId('admin-plus-remove')?.addEventListener('click', () => guard(byId('admin-plus-remove'), async () => {
    if (profile?.role !== 'admin') throw new Error('Accès administrateur requis.');
    const target = byId('admin-plus-target').value.trim();
    if (!target) throw new Error('Indiquez un pseudo ou une adresse email.');
    const jeu = await gameRequest('/api/game/site-plus', { target, until: null }).catch(() => null);
    if (!(jeu && jeu.ok)) {
      const site = await client.rpc('recblue_grant_plus', { p_identifier: target, p_until: null });
      if (site.error) throw site.error;
    }
    say(jeu && jeu.ok
      ? 'REC BLUE Plus retiré à ' + target + ', y compris dans le jeu.'
      : 'REC BLUE Plus retiré côté site, mais le jeu n’a pas suivi' + (jeu && jeu.error ? ' : ' + jeu.error : '.') + '.');
    await loadProfile();
  }));

  // Bannissement : le joueur visé ne peut plus se connecter au jeu (durée vide = définitif).
  byId('admin-ban')?.addEventListener('submit', event => {
    event.preventDefault();
    guard(byId('admin-ban-submit'), async () => {
      if (profile?.role !== 'admin') throw new Error('Accès administrateur requis.');
      const target = byId('admin-ban-target').value.trim();
      if (!target) throw new Error('Indiquez un pseudo de jeu ou une adresse email.');
      const reason = byId('admin-ban-reason').value.trim();
      const days = byId('admin-ban-days').value;
      const duree = days === '' ? 'définitif' : Number(days) + ' jours';
      const result = await gameRequest('/api/game/ban', { target, ban: true, reason, days });
      if (!result || !result.ok) throw new Error((result && result.error) || 'Bannissement refusé.');
      say('Joueur banni : ' + target + ' (' + duree + ')' + (reason ? ' — ' + reason : '') + '.');
      byId('admin-ban-target').value = '';
      byId('admin-ban-reason').value = '';
      byId('admin-ban-days').value = '';
    });
  });

  byId('admin-ban-lift')?.addEventListener('click', () => guard(byId('admin-ban-lift'), async () => {
    if (profile?.role !== 'admin') throw new Error('Accès administrateur requis.');
    const target = byId('admin-ban-target').value.trim();
    if (!target) throw new Error('Indiquez le pseudo du joueur à débannir.');
    const result = await gameRequest('/api/game/ban', { target, ban: false });
    if (!result || !result.ok) throw new Error((result && result.error) || 'Débannissement refusé.');
    say('Joueur débanni : ' + target + '.');
    byId('admin-ban-target').value = '';
  }));

  // Retrait de crédits : correction de solde côté jeu (le solde affiché est celui du jeu).
  byId('admin-debit')?.addEventListener('submit', event => {
    event.preventDefault();
    guard(byId('admin-debit-submit'), async () => {
      if (profile?.role !== 'admin') throw new Error('Accès administrateur requis.');
      const target = byId('admin-debit-target').value.trim();
      if (!target) throw new Error('Indiquez un pseudo de jeu ou une adresse email.');
      const amount = Number(byId('admin-debit-amount').value);
      if (!Number.isInteger(amount) || amount < 1) throw new Error('Indiquez un nombre de crédits entier, au moins 1.');
      const result = await gameRequest('/api/game/debit', { target, tokens: amount });
      if (!result || !result.ok) throw new Error((result && result.error) || 'Retrait refusé.');
      const reste = Number(result.credits) || 0;
      const retire = Number(result.removed) || 0;
      say('Crédits retirés à ' + target + ' : ' + formatCredits(retire) + ' retirés, nouveau solde en jeu ' + formatCredits(reste) + '.'
        + (retire < amount ? ' Le solde ne couvrait pas la totalité.' : ''));
      byId('admin-debit-amount').value = '';
      await loadProfile();
    });
  });

  byId('lang').addEventListener('change', () => { savePref('recblue.language', byId('lang').value); document.documentElement.lang = byId('lang').value; say('Langue enregistrée pour ce navigateur.'); });
  byId('music').addEventListener('change', () => { savePref('recblue.musicOff', String(!byId('music').checked)); say(byId('music').checked ? 'Musique activée sur ce navigateur.' : 'Musique désactivée sur ce navigateur.'); });
  byId('pings').addEventListener('change', () => { savePref('recblue.updatePings', String(byId('pings').checked)); say('Préférence de notifications enregistrée.'); });



  async function loadResetRequests() {
    const { data, error } = await client.from('recblue_reset_requests').select('id,pseudo,contact_email,message,created_at').eq('status', 'nouveau').order('created_at', { ascending: true }).limit(50);
    if (error) throw error;
    const list = byId('reset-list');
    if (!data.length) { list.textContent = 'Aucune demande en attente.'; return; }
    const fragment = document.createDocumentFragment();
    data.forEach(request => {
      const row = document.createElement('div'); row.className = 'user';
      const info = document.createElement('span');
      const meta = document.createElement('small');
      info.textContent = request.pseudo;
      meta.textContent = (request.contact_email || 'sans email') + ' · ' + formatDate(request.created_at) + (request.message ? ' · ' + request.message : '');
      info.append(meta);
      const done = document.createElement('button');
      done.type = 'button'; done.className = 'btn ghost'; done.textContent = 'Traité';
      done.addEventListener('click', () => guard(done, async () => {
        const { error: updateError } = await client.from('recblue_reset_requests').update({ status: 'traite' }).eq('id', request.id);
        if (updateError) throw new Error('Mise à jour impossible.');
        say('Demande marquée comme traitée : réinitialisez le mot de passe dans Supabase.');
        await loadResetRequests();
      }));
      row.append(info, done); fragment.append(row);
    });
    list.replaceChildren(fragment);
  }
  byId('reset-refresh').addEventListener('click', () => guard(byId('reset-refresh'), loadResetRequests));
  byId('mfa-alert-go').addEventListener('click', () => {
    byId('mfa-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
    byId('totp-start').focus();
    say('Activez l’application d’authentification, puis saisissez le code à 6 chiffres.');
  });
  byId('email-form').addEventListener('submit', event => {
    event.preventDefault();
    guard(event.submitter, async () => {
      if (!profile) throw new Error('Profil indisponible : reconnectez-vous.');
      const value = byId('contact-email').value.trim().toLowerCase();
      if (value && value.length > 254) throw new Error('Adresse email trop longue.');
      if (value && !/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/.test(value)) throw new Error('Adresse email invalide : exemple prenom@exemple.com.');
      if (value.endsWith('@players.recblue.invalid')) throw new Error('Cette adresse technique ne peut pas être utilisée.');
      const { data, error } = await client.from('recblue_accounts').update({ contact_email: value || null }).eq('id', profile.id).select('id').single();
      if (error || !data) throw new Error('Enregistrement refusé : ' + (error?.message || 'la colonne contact_email doit exister.'));
      say(value ? 'Adresse email enregistrée.' : 'Adresse email retirée.');
      await loadProfile();
    });
  });
  byId('avatar-file').addEventListener('change', event => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    guard(null, async () => {
      if (!profile) throw new Error('Profil indisponible : reconnectez-vous.');
      const dataUrl = await prepareAvatar(file);
      const { data, error } = await client.from('recblue_accounts').update({ avatar_url: dataUrl }).eq('id', profile.id).select('id').single();
      if (error || !data) throw new Error('Enregistrement refusé : ' + (error?.message || 'la colonne avatar_url doit exister.'));
      say('Photo de profil mise à jour.');
      await loadProfile();
    });
  });
  byId('avatar-remove').addEventListener('click', () => guard(byId('avatar-remove'), async () => {
    if (!profile) throw new Error('Profil indisponible : reconnectez-vous.');
    const { error } = await client.from('recblue_accounts').update({ avatar_url: null }).eq('id', profile.id).select('id').single();
    if (error) throw new Error('Suppression refusée. Réessayez.');
    say('Photo de profil retirée.');
    await loadProfile();
  }));
  byId('totp-start').addEventListener('click', () => guard(byId('totp-start'), async () => {
    const { data, error } = await client.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'REC BLUE · ' + (profile?.display_name || 'compte') });
    if (error) throw new Error('Activation impossible : ' + (error.message || 'la 2FA doit être autorisée dans Supabase.'));
    pendingFactorId = data.id;
    byId('totp-qr').src = data.totp.qr_code;
    byId('totp-secret').textContent = data.totp.secret;
    byId('totp-setup').hidden = false;
    say('Scannez le QR code avec Google Authenticator (ou une autre application), puis saisissez le code affiché.');
  }));
  byId('totp-cancel').addEventListener('click', () => guard(byId('totp-cancel'), async () => {
    if (pendingFactorId) { await client.auth.mfa.unenroll({ factorId: pendingFactorId }); pendingFactorId = ''; }
    byId('totp-setup').hidden = true; byId('totp-code').value = '';
    say('Activation annulée.');
  }));
  byId('totp-confirm').addEventListener('click', () => guard(byId('totp-confirm'), async () => {
    const code = byId('totp-code').value.trim();
    if (!/^\d{6}$/.test(code)) throw new Error('Le code doit contenir 6 chiffres.');
    if (!pendingFactorId) throw new Error('Recommencez l’activation de la 2FA.');
    const { error } = await client.auth.mfa.challengeAndVerify({ factorId: pendingFactorId, code });
    if (error) throw new Error('Code refusé. Vérifiez l’heure de votre téléphone, puis réessayez.');
    pendingFactorId = '';
    byId('totp-setup').hidden = true; byId('totp-code').value = '';
    say('Double authentification activée : un code sera demandé à chaque connexion.');
    await loadFactors(); await loadProfile();
  }));
  byId('phone-start').addEventListener('click', () => guard(byId('phone-start'), async () => {
    const phone = byId('phone-number').value.replace(/\s+/g, '');
    if (!/^\+\d{8,15}$/.test(phone)) throw new Error('Indiquez le numéro au format international, par exemple +33612345678.');
    const { data, error } = await client.auth.mfa.enroll({ factorType: 'phone', friendlyName: 'SMS REC BLUE', phone });
    if (error) throw new Error('Envoi impossible : ' + (error.message || 'un fournisseur SMS doit être configuré dans Supabase.'));
    pendingFactorId = data.id;
    const challenge = await client.auth.mfa.challenge({ factorId: data.id });
    if (challenge.error) throw new Error('Envoi du SMS impossible : ' + (challenge.error.message || 'fournisseur SMS non configuré dans Supabase.'));
    phoneChallengeId = challenge.data.id;
    byId('phone-setup').hidden = false;
    byId('phone-code').value = '';
    say('Code envoyé par SMS. Saisissez-le pour confirmer le numéro.');
  }));
  byId('phone-confirm').addEventListener('click', () => guard(byId('phone-confirm'), async () => {
    const code = byId('phone-code').value.trim();
    if (!/^\d{6}$/.test(code)) throw new Error('Le code doit contenir 6 chiffres.');
    if (!pendingFactorId || !phoneChallengeId) throw new Error('Demandez d’abord un code par SMS.');
    const { error } = await client.auth.mfa.verify({ factorId: pendingFactorId, challengeId: phoneChallengeId, code });
    if (error) throw new Error('Code refusé ou expiré. Demandez un nouveau code.');
    pendingFactorId = ''; phoneChallengeId = '';
    byId('phone-setup').hidden = true; byId('phone-code').value = '';
    say('Double authentification par téléphone activée.');
    await loadFactors(); await loadProfile();
  }));
  byId('gate-send').addEventListener('click', () => guard(byId('gate-send'), async () => {
    const factor = factors.phone[0];
    if (!factor) throw new Error('Aucun numéro enregistré.');
    const challenge = await client.auth.mfa.challenge({ factorId: factor.id });
    if (challenge.error) throw new Error('Envoi impossible : ' + (challenge.error.message || 'fournisseur SMS non configuré.'));
    pendingFactorId = factor.id; phoneChallengeId = challenge.data.id;
    say('Code envoyé par SMS.');
  }));
  byId('gate-verify').addEventListener('click', () => guard(byId('gate-verify'), async () => {
    const code = byId('gate-code').value.trim();
    if (!/^\d{6}$/.test(code)) throw new Error('Le code doit contenir 6 chiffres.');
    const totp = factors.totp[0];
    const phone = factors.phone[0];
    if (!totp && !phone) throw new Error('Aucun facteur disponible : contactez un administrateur.');
    let error;
    if (totp) ({ error } = await client.auth.mfa.challengeAndVerify({ factorId: totp.id, code }));
    else ({ error } = await client.auth.mfa.verify({ factorId: phone.id, challengeId: phoneChallengeId, code }));
    if (error) throw new Error('Code refusé ou expiré. Réessayez.');
    byId('gate').hidden = true;
    byId('gate-code').value = '';
    say('Vérification réussie.');
    await loadProfile();
  }));

  // ---- Mot de passe oublié ----------------------------------------------------
  // Un compte créé avec un pseudo porte une adresse technique (.invalid) qui ne reçoit
  // rien : le lien de réinitialisation ne peut donc partir que vers une vraie adresse,
  // enregistrée ici depuis Mon compte (confirmation Supabase) ou à l’inscription.
  byId('reset-request')?.addEventListener('submit', event => {
    event.preventDefault();
    guard(event.target.querySelector('button[type="submit"]'), async () => {
      if (!client) throw new Error('Service de comptes indisponible.');
      const email = byId('reset-email').value.trim().toLowerCase();
      if (!email.includes('@')) throw new Error('Indiquez l’adresse email enregistrée sur le compte.');
      const { error } = await client.auth.resetPasswordForEmail(email, {
        redirectTo: (config?.siteOrigin || 'https://recblue.net') + location.pathname + '?reset=1'
      });
      if (error) throw error;
      say('Si un compte utilise ' + email + ', un lien de réinitialisation vient de partir. Pensez à regarder les indésirables.');
      byId('reset-request').reset();
    });
  });

  // Retour depuis le lien de réinitialisation : le jeton de récupération ouvre une session,
  // on propose donc le nouveau mot de passe, puis on se reconnecte avec.
  byId('reset-apply-form')?.addEventListener('submit', event => {
    event.preventDefault();
    guard(event.target.querySelector('button[type="submit"]'), async () => {
      if (!client) throw new Error('Service de comptes indisponible.');
      const password = byId('reset-pw').value;
      if (password.length < 12) throw new Error('12 caractères minimum pour le nouveau mot de passe.');
      const { error } = await client.auth.updateUser({ password });
      if (error) throw error;
      byId('reset-pw').value = '';
      say('Mot de passe du site enregistré. Le mot de passe du jeu ne change pas automatiquement.');
      document.getElementById('reset-apply').hidden = true;
      await loadProfile();
    });
  });

  // Adresse de récupération : c’est l’adresse de connexion du compte, donc celle que
  // Supabase utilise pour le lien « mot de passe oublié ».
  byId('recovery-email')?.addEventListener('submit', event => {
    event.preventDefault();
    guard(event.target.querySelector('button[type="submit"]'), async () => {
      if (!client) throw new Error('Service de comptes indisponible.');
      const email = byId('recovery-email-input').value.trim().toLowerCase();
      if (!email.includes('@')) throw new Error('Indiquez une adresse email valide.');
      const { error } = await client.auth.updateUser({ email });
      if (error) throw error;
      say('Adresse de récupération enregistrée : une confirmation part vers ' + email + '. Cliquez son lien pour l’activer.');
    });
  });

  function showResetCard() {
    const card = document.getElementById('reset-apply');
    if (!card) return;
    card.hidden = false;
    card.scrollIntoView({ block: 'start' });
  }

  async function init() {
    if (!config?.supabaseUrl || !config?.publishableKey) { say('Service de comptes non configuré.'); return; }
    // Un ancien lien (ou une demande faite depuis un apercu) peut arriver sur un autre
    // domaine : on repart sur le vrai site en conservant le jeton du lien.
    const canonique = new URL(config.siteOrigin || 'https://recblue.net');
    const jeton = /(?:access_token=|type=recovery)/.test(location.hash);
    const local = /^(localhost|127.0.0.1|[::1])$/.test(location.hostname);
    if (jeton && !local && location.hostname !== canonique.hostname) {
      location.replace(canonique.origin + '/compte.html' + location.hash);
      return;
    }
    try {
      const url = new URL(config.supabaseUrl);
      if (url.protocol !== 'https:' || !/^[a-z0-9-]+\.supabase\.co$/i.test(url.hostname) || !/^(sb_publishable_|eyJ)/.test(config.publishableKey)) throw new Error('Configuration Supabase invalide.');
      if (!window.supabase?.createClient) throw new Error('Service de comptes indisponible.');
      client = window.supabase.createClient(url.href, config.publishableKey, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
      client.auth.onAuthStateChange((event) => {
        // Retour du lien email : Supabase ouvre une session de recuperation.
        if (event === 'PASSWORD_RECOVERY') showResetCard();
        loadProfile().catch(() => say('Session non vérifiée.'));
      });
      byId('lang').value = readPref('recblue.language', 'fr');
      byId('music').checked = readPref('recblue.musicOff', 'false') !== 'true';
      byId('pings').checked = readPref('recblue.updatePings', 'false') === 'true';
      await loadProfile();
      // Retour depuis le lien de réinitialisation : la carte « nouveau mot de passe »
      // s’affiche au-dessus, que la session de récupération soit ouverte ou non.
      if (new URLSearchParams(location.search).get('reset') === '1' || /type=recovery/.test(location.hash)) {
        showResetCard();
        say('Lien de réinitialisation reconnu : choisissez votre nouveau mot de passe.');
      }
    } catch (error) { say(error.message); }
  }
  init();
})();
