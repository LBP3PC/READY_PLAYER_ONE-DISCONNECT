(() => {
  const byId = id => document.getElementById(id);
  const message = byId('account-message');
  const config = window.RECBLUE_ACCOUNTS;
  // Supabase a besoin d'un identifiant de type email. Les comptes créés avec un
  // pseudo reçoivent une adresse technique réservée (.invalid, jamais délivrable).
  const PSEUDO_DOMAIN = 'players.recblue.invalid';
  const PSEUDO_PATTERN = /^[a-z0-9_][a-z0-9_-]{2,19}$/;
  let client;
  let profile = null;
  let revision = 0;
  const announce = text => { message.textContent = text; };
  const labels = { member: 'Membre', moderator: 'Modérateur', admin: 'Administrateur' };
  const navLink = document.querySelector('a.nav-control[href="#connexion"]');
  const navLabel = byId('nav-account-label');
  const navBubble = byId('nav-avatar');
  // Photo acceptée : une image du site (data URL) ou la photo du JEU, servie par le
  // service d'images du jeu.
  const AVATAR = /^(data:image\/(png|jpeg|webp);base64,|https:\/\/img\.recblue\.net\/)/;
  // Affiche l’identité du membre dans la barre : bulle de profil + @pseudo.
  const setNavLabel = (label, avatar, plus = false) => {
    if (!navLink) return;
    const signedOut = label === 'Se connecter';
    if (navLabel) {
      navLabel.textContent = label;
      navLabel.classList.toggle('plus-name', !signedOut && plus);
      const navMark = byId('nav-plus');
      if (navMark) navMark.hidden = signedOut || !plus;
      // La coche de certification est décidée par le compte de jeu (voir refreshAccount).
      const navCert = byId('nav-certified');
      if (navCert && signedOut) navCert.hidden = true;
      if (signedOut) { navLabel.setAttribute('data-i18n', 'login'); navLabel.removeAttribute('data-no-translate'); }
      else { navLabel.removeAttribute('data-i18n'); navLabel.setAttribute('data-no-translate', ''); }
    } else {
      navLink.textContent = label;
    }
    // Empêche le traducteur de remplacer le pseudo du joueur.
    if (signedOut) navLink.removeAttribute('data-no-translate');
    else navLink.setAttribute('data-no-translate', '');
    if (navBubble) {
      const photo = typeof avatar === 'string' && AVATAR.test(avatar);
      navBubble.hidden = signedOut;
      navBubble.classList.toggle('has-photo', photo);
      // Anneau doré réservé aux membres REC BLUE Plus.
      navBubble.classList.toggle('plus-ring', !signedOut && plus);
      navBubble.style.backgroundImage = photo ? 'url("' + avatar + '")' : '';
      navBubble.textContent = signedOut || photo ? '' : label.replace(/^@/, '').trim().slice(0, 2).toUpperCase();
    }
  };
  const isPlus = value => !!value && new Date(value).getTime() > Date.now();
  const normalizePseudo = value => String(value || '').trim().toLowerCase();
  const pseudoEmail = pseudo => pseudo + '@' + PSEUDO_DOMAIN;
  const pseudoFromEmail = email => {
    const value = String(email || '').toLowerCase();
    const suffix = '@' + PSEUDO_DOMAIN;
    return value.endsWith(suffix) ? value.slice(0, -suffix.length) : '';
  };
  function checkPseudo(value) {
    const pseudo = normalizePseudo(value);
    if (!PSEUDO_PATTERN.test(pseudo)) throw new Error('Pseudo invalide : 3 à 20 lettres, chiffres, tiret ou souligné.');
    return pseudo;
  }
  // Séparateur de milliers VISIBLE : l'espace fine de fr-FR (U+202F) est invisible dans
  // la police d'affichage du site, ce qui collait les gros soldes (« 4635662 »).
  function formatCredits(value) {
    return String(Math.round(Number(value) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  }
  // Garde la pièce et le texte de crédits dans la pastille, même si elle a été vidée.
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
  // Les crédits du site et du jeu sont le MÊME nombre : le solde affiché est lu sur le
  // serveur de jeu, et un don d'administration part aussi dans le jeu.
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
  // La photo du JEU du joueur connecté (le site affiche celle-là, pas une copie).
  async function gameAvatarUrl() {
    try {
      const token = await sessionToken();
      if (!token) return '';
      const response = await fetch('/api/game/avatar', { headers: { Authorization: 'Bearer ' + token }, cache: 'no-store' });
      const body = await response.json().catch(() => null);
      return response.ok && body && typeof body.image === 'string' ? body.image : '';
    } catch (error) { return ''; }
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
  function clearPrivateUI() {
    profile = null;
    setNavLabel('Se connecter');
    byId('account-profile').hidden = true;
    byId('account-admin').hidden = true;
    if (navBubble) navBubble.classList.remove('plus-ring');
    const navCertOff = byId('nav-certified');
    if (navCertOff) navCertOff.hidden = true;
    byId('account-users').replaceChildren();
    byId('account-email').textContent = '';
    byId('account-role').textContent = '';
    byId('account-name').value = '';
    const navCredits = byId('nav-credits');
    if (navCredits) {
      navCredits.hidden = true;
      navCredits.classList.remove('plus-credits');
    }
  }
  async function refreshAccount() {
    const current = ++revision;
    clearPrivateUI();
    byId('account-guest').hidden = false;
    const { data, error } = await client.auth.getUser();
    if (current !== revision) return;
    if (error || !data.user) {
      if (error && error.name !== 'AuthSessionMissingError') announce('Session non vérifiée. Reconnectez-vous ou réessayez.');
      return;
    }
    if (await mfaPending()) { showMfaPrompt(); return; }
    byId('account-guest').hidden = true;
    byId('account-profile').hidden = false;
    const pseudo = pseudoFromEmail(data.user.email);
    byId('account-email').textContent = pseudo ? '@' + pseudo : (data.user.email || '');
    const result = await client.from('recblue_accounts').select('id,display_name,role,avatar_url,credits,plus_until').eq('id', data.user.id).single();
    if (current !== revision) return;
    if (result.error) { announce('Profil inaccessible. Vérifiez la configuration SQL et réessayez.'); return; }
    profile = result.data;
    // Plus et certification vivent sur le compte de JEU : on lit l'état réel, pas une copie.
    const jeu = await gameStatus();
    const plusSite = isPlus(profile.plus_until) || jeu.plus;
    setNavLabel('@' + (pseudo || profile.display_name), (await gameAvatarUrl()) || profile.avatar_url, plusSite);
    const creditsBadge = byId('nav-credits');
    if (creditsBadge) {
      const soldeJeu = await gameCredits();
      const total = soldeJeu === null ? (Number(profile.credits) || 0) : soldeJeu;
      const creditsText = formatCredits(total) + (total === 1 ? ' crédit' : ' crédits');
      const creditsValue = creditsLabel(creditsBadge);
      if (creditsValue) creditsValue.textContent = creditsText;
      // Membre REC BLUE Plus : la pastille de crédits passe en or.
      creditsBadge.classList.toggle('plus-credits', plusSite);
      creditsBadge.hidden = false;
    }
    byId('account-name').value = profile.display_name;
    // Le rôle affiché est celui du site : un rôle retiré ici ne doit jamais réapparaître.
    const roleEffectif = profile.role;
    byId('account-role').textContent = labels[roleEffectif] || 'Droit inconnu';
    byId('account-role').className = 'badge' + (roleEffectif === 'admin' ? ' admin' : roleEffectif === 'moderator' ? ' mod' : '');
    const certified = jeu.certified;
    const certBadge = byId('account-certified');
    if (certBadge) certBadge.hidden = !certified;
    const navCert = byId('nav-certified');
    if (navCert) navCert.hidden = !certified;
    const plusBadge = byId('account-plus');
    if (plusBadge) plusBadge.hidden = !plusSite;
    byId('account-admin').hidden = !(profile.role === 'admin' || profile.role === 'moderator');
    // Les crédits et le Plus restent réservés aux administrateurs : un
    // modérateur ne voit que la liste des comptes.
    const isAdminMember = profile.role === 'admin';
    ['admin-credits', 'admin-plus', 'admin-maintenance', 'admin-announcement'].forEach(id => {
      const block = byId(id);
      if (block) block.hidden = !isAdminMember;
    });
    if (isAdminMember) loadMaintenanceAdmin();
    const factorList = await client.auth.mfa.listFactors();
    const verifiedFactors = (factorList.data?.all || []).filter(factor => factor.status === 'verified').length;
    const mfaNote = byId('account-mfa-note');
    if (mfaNote) mfaNote.hidden = verifiedFactors > 0;
  }
  async function run(button, action) {
    button.disabled = true;
    try { await action(); } catch (error) { announce(error.message || 'Service inaccessible. Réessayez.'); }
    finally { button.disabled = false; }
  }
  let mfaChallengeId = '';
  async function mfaPending() {
    const { data, error } = await client.auth.mfa.getAuthenticatorAssuranceLevel();
    if (error) return false;
    return data.currentLevel === 'aal1' && data.nextLevel === 'aal2';
  }
  function showMfaPrompt(hint) {
    byId('account-guest').hidden = true;
    byId('account-profile').hidden = true;
    byId('account-mfa').hidden = false;
    byId('mfa-hint').textContent = hint || 'Code à 6 chiffres : application d’authentification.';
  }
  /**
   * Change le rôle d'un compte : le Worker l'écrit en base avec la clé de service (et
   * répercute le rôle en jeu) ; la RPC SQL sert de secours.
   */
  async function setSiteRole(account, role) {
    const viaWorker = await gameRequest('/api/game/site-role', {
      id: account.id,
      role,
      target: account.display_name
    }).catch(() => null);
    // Le Worker répond même quand la fiche du site refuse : il indique alors lequel des
    // deux côtés a cédé, au lieu de laisser croire que rien n'a été tenté.
    if (viaWorker && viaWorker.site) return viaWorker;
    const { error } = await client.rpc('recblue_set_role', { target_id: account.id, new_role: role });
    if (error) {
      await refreshAccount();
      throw new Error((viaWorker && viaWorker.error) || error.message || 'Changement de rôle refusé.');
    }
    const game = await gameRequest('/api/game/role', { target: account.display_name, role }).catch(() => null);
    return { ok: true, role, game };
  }

  async function listAccounts() {
    const result = await client.from('recblue_accounts').select('id,display_name,role,created_at').order('created_at', { ascending: false }).limit(100);
    if (result.error) throw result.error;
    const accounts = result.data;
    await refreshAccount();
    if (!profile || !(profile.role === 'admin' || profile.role === 'moderator')) throw new Error('Accès réservé à l’équipe.');
    const fragment = document.createDocumentFragment();
    accounts.forEach(account => {
      const row = document.createElement('div'); row.className = 'detail-row';
      const name = document.createElement('span'); name.textContent = account.display_name; name.dataset.noTranslate = '';
      const id = document.createElement('small'); id.textContent = account.id; name.append(id);
      const select = document.createElement('select'); select.className = 'language-select'; select.setAttribute('aria-label', 'Droits de ' + account.display_name);
      Object.entries(labels).forEach(([value, label]) => { const option = document.createElement('option'); option.value = value; option.textContent = label; select.append(option); });
      select.value = account.role;
      const save = document.createElement('button'); save.type = 'button'; save.className = 'button'; save.textContent = 'Appliquer';
      // Seul un administrateur peut changer les droits ; un modérateur consulte la liste.
      const isAdmin = profile.role === 'admin';
      select.disabled = !isAdmin; save.disabled = !isAdmin; save.hidden = !isAdmin;
      save.addEventListener('click', () => run(save, async () => {
        const synced = await setSiteRole(account, select.value);
        const label = labels[select.value] || select.value;
        const game = synced.game || {};
        const site = synced.site || {};
        if (site.ok && game.ok) announce('Droits de ' + account.display_name + ' : ' + label + ' sur le site ET en jeu (effectif à sa prochaine connexion).');
        else if (!game.ok) announce('Rôle du site : ' + (site.ok ? label : 'refusé') + '. En jeu, le rôle n’a pas suivi : ' + (game.error || 'serveur de jeu injoignable') + '.');
        else announce('Rôle de jeu passé à ' + label + ', mais la fiche du site a refusé : ' + (site.error || 'erreur inconnue') + '.');
        await refreshAccount();
        if (profile?.role === 'admin') await listAccounts();
      }));
      // Le badge « Certifié REC BLUE » : accordé par l’administration, rangé sur le compte de jeu.
      const certify = document.createElement('button'); certify.type = 'button'; certify.className = 'button'; certify.textContent = 'Certifier';
      certify.disabled = !isAdmin; certify.hidden = !isAdmin;
      certify.addEventListener('click', () => run(certify, async () => {
        const on = certify.dataset.certified !== '1';
        const result = await gameRequest('/api/game/certify', { target: account.display_name, certified: on });
        if (!result || !result.ok) throw new Error((result && result.error) || 'Certification refusée.');
        certify.dataset.certified = on ? '1' : '0';
        certify.textContent = on ? 'Retirer la certification' : 'Certifier';
        announce((on ? 'Compte certifié : ' : 'Certification retirée : ') + account.display_name + '.');
      }));
      row.append(name, select, save, certify); fragment.append(row);
    });
    byId('account-users').replaceChildren(fragment);
  }
  let maintenanceState = { active: false, message: '', code: '' };
  function applyMaintenanceState(data) {
    maintenanceState = {
      active: !!(data && data.active),
      message: String((data && data.message) || ''),
      code: String((data && data.code) || '')
    };
    const block = byId('admin-maintenance');
    if (block) block.hidden = !(profile && profile.role === 'admin');
    const state = byId('maintenance-state');
    if (state) state.textContent = maintenanceState.active
      ? 'Maintenance active : les joueurs doivent saisir le code.'
      : 'Jeu ouvert : le launcher démarre normalement.';
    const toggle = byId('maintenance-toggle');
    if (toggle) toggle.textContent = maintenanceState.active ? 'Désactiver la maintenance' : 'Activer la maintenance';
    const message = byId('maintenance-message');
    if (message) message.value = maintenanceState.message;
    const code = byId('maintenance-code');
    if (code) code.value = maintenanceState.code;
  }
  async function loadMaintenanceAdmin() {
    if (!profile || profile.role !== 'admin') {
      const block = byId('admin-maintenance');
      if (block) block.hidden = true;
      return;
    }
    try {
      const token = await sessionToken();
      if (!token) return;
      const response = await fetch('/api/maintenance', {
        headers: { Authorization: 'Bearer ' + token },
        cache: 'no-store'
      });
      if (!response.ok) return;
      applyMaintenanceState(await response.json());
    } catch {}
  }
  const maintenanceForm = byId('admin-maintenance-form');
  if (maintenanceForm) maintenanceForm.addEventListener('submit', event => {
    event.preventDefault();
    run(byId('maintenance-toggle'), async () => {
      if (!profile || profile.role !== 'admin') throw new Error('Accès administrateur requis.');
      const token = await sessionToken();
      if (!token) throw new Error('Session absente : reconnecte-toi.');
      const active = !maintenanceState.active;
      const message = String(byId('maintenance-message').value || '').trim();
      const code = String(byId('maintenance-code').value || '').trim();
      const response = await fetch('/api/maintenance', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ active, message, code })
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error((body && body.error) || ('statut ' + response.status));
      applyMaintenanceState(body);
      announce(active
        ? 'Maintenance activée : les joueurs doivent saisir le code.'
        : 'Maintenance désactivée : le launcher redémarre normalement.');
    });
  });
  // Message général dans le jeu : envoyé au serveur, qui le pousse depuis « Coach ».
  const announcementForm = byId('admin-announcement-form');
  if (announcementForm) announcementForm.addEventListener('submit', event => {
    event.preventDefault();
    run(byId('admin-announcement-submit'), async () => {
      if (!profile || profile.role !== 'admin') throw new Error('Accès administrateur requis.');
      const input = byId('admin-announcement-message');
      const text = String(input.value || '').trim();
      if (!text) throw new Error('Écris le message à envoyer.');
      if (text.length > 500) throw new Error('Message trop long (500 caractères maximum).');
      const result = await gameRequest('/api/game/announce', { message: text });
      if (!result || !result.ok) throw new Error((result && result.error) || 'Envoi refusé.');
      const sent = Number(result.sent) || 0;
      const status = byId('admin-announcement-result');
      if (status) status.textContent = sent === 0
        ? 'Aucun joueur connecté : le message n’a été reçu par personne.'
        : 'Message Coach envoyé à ' + sent + (sent === 1 ? ' joueur connecté.' : ' joueurs connectés.');
      input.value = '';
      announce(sent === 0
        ? 'Message prêt, mais aucun joueur connecté.'
        : 'Message général envoyé à ' + sent + ' joueur' + (sent === 1 ? '.' : 's.'));
    });
  });
  const creditsForm = byId('admin-credits');
  if (creditsForm) creditsForm.addEventListener('submit', event => {
    event.preventDefault();
    run(byId('admin-credits-submit'), async () => {
      if (!profile || !(profile.role === 'admin' || profile.role === 'moderator')) throw new Error('Accès réservé à l’équipe.');
      const target = byId('admin-credits-target').value.trim();
      const amount = Number(byId('admin-credits-amount').value);
      if (!target) throw new Error('Indiquez un pseudo ou une adresse email.');
      if (!Number.isInteger(amount) || amount < 1) throw new Error('Indiquez un nombre de crédits entier, au moins 1.');
      const { data, error } = await client.rpc('recblue_grant_credits', { p_identifier: target, p_amount: amount });
      // Un joueur peut exister EN JEU sans fiche sur le site (compte créé en jeu) : le don
      // doit quand même arriver, donc on n'abandonne que si les DEUX côtés refusent.
      const jeu = await grantGame(target, amount);
      if (error) {
        if (!jeu || !jeu.ok) throw new Error('Don impossible pour « ' + target + ' » : ' + (jeu && jeu.error ? jeu.error : (error.message || 'compte introuvable')) + '.');
        announce('Crédits envoyés en jeu à ' + target + ' : solde en jeu ' + formatCredits(jeu.credits || 0) + ', box envoyée (aucune fiche de site à créditer).');
      } else {
        announce(jeu && jeu.ok
          ? 'Crédits ajoutés à ' + target + ' : solde en jeu ' + formatCredits(jeu.credits || 0) + ', box envoyée.'
          : 'Crédits ajoutés côté site (' + formatCredits(data) + '), mais le jeu n’a pas été crédité' + (jeu && jeu.error ? ' : ' + jeu.error : '.') + '.');
      }
      byId('admin-credits-amount').value = '';
      await refreshAccount();
    });
  });
  // Retrait de crédits : correction de solde côté jeu (le solde affiché est celui du jeu).
  const debitForm = byId('admin-debit');
  if (debitForm) debitForm.addEventListener('submit', event => {
    event.preventDefault();
    run(byId('admin-debit-submit'), async () => {
      if (!profile || profile.role !== 'admin') throw new Error('Accès administrateur requis.');
      const target = String(byId('admin-debit-target').value || '').trim();
      if (!target) throw new Error('Indiquez un pseudo de jeu ou une adresse email.');
      const amount = Number(byId('admin-debit-amount').value);
      if (!Number.isInteger(amount) || amount < 1) throw new Error('Indiquez un nombre de crédits entier, au moins 1.');
      const result = await gameRequest('/api/game/debit', { target, tokens: amount });
      if (!result || !result.ok) throw new Error((result && result.error) || 'Retrait refusé.');
      const reste = Number(result.credits) || 0;
      const retire = Number(result.removed) || 0;
      announce('Crédits retirés à ' + target + ' : ' + formatCredits(retire) + ' retirés, nouveau solde en jeu ' + formatCredits(reste) + '.'
        + (retire < amount ? ' Le solde ne couvrait pas la totalité.' : ''));
      byId('admin-debit-amount').value = '';
      await refreshAccount();
    });
  });

  // REC BLUE Plus : un administrateur choisit la date de fin (ou retire l’avantage).
  const plusForm = byId('admin-plus');
  const plusTarget = target => {
    const value = String(target || '').trim();
    if (!value) throw new Error('Indiquez un pseudo ou une adresse email.');
    return value;
  };
  if (plusForm) plusForm.addEventListener('submit', event => {
    event.preventDefault();
    run(byId('admin-plus-submit'), async () => {
      if (!profile || profile.role !== 'admin') throw new Error('Accès administrateur requis.');
      const target = plusTarget(byId('admin-plus-target').value);
      const day = byId('admin-plus-date').value;
      if (!day) throw new Error('Choisissez la date de fin du REC BLUE Plus.');
      const until = new Date(day + 'T23:59:59');
      if (until.getTime() <= Date.now()) throw new Error('La date de fin doit être dans le futur.');
      // Le jeu d'abord : la fiche du site est facultative, un joueur peut n'exister qu'en jeu.
      const site = await client.rpc('recblue_grant_plus', { p_identifier: target, p_until: until.toISOString() });
      const jeu = await gameRequest('/api/game/plus', { target, until: until.toISOString() });
      if (site.error && !(jeu && jeu.ok)) throw site.error;
      announce(jeu && jeu.ok
        ? 'REC BLUE Plus accordé à ' + target + ' jusqu’au ' + until.toLocaleDateString('fr-FR') + ', actif dans le jeu.'
        : 'REC BLUE Plus accordé côté site jusqu’au ' + until.toLocaleDateString('fr-FR') + ', mais le jeu n’a pas suivi' + (jeu && jeu.error ? ' : ' + jeu.error : '.') + '.');
      byId('admin-plus-date').value = '';
      await refreshAccount();
    });
  });
  const plusRemove = byId('admin-plus-remove');
  if (plusRemove) plusRemove.addEventListener('click', () => run(plusRemove, async () => {
    if (!profile || profile.role !== 'admin') throw new Error('Accès administrateur requis.');
    const target = plusTarget(byId('admin-plus-target').value);
    const site = await client.rpc('recblue_grant_plus', { p_identifier: target, p_until: null });
    const jeu = await gameRequest('/api/game/plus', { target, until: null });
    if (site.error && !(jeu && jeu.ok)) throw site.error;
    announce(jeu && jeu.ok
      ? 'REC BLUE Plus retiré à ' + target + ', y compris dans le jeu.'
      : 'REC BLUE Plus retiré côté site, mais le jeu n’a pas suivi' + (jeu && jeu.error ? ' : ' + jeu.error : '.') + '.');
    await refreshAccount();
  }));

  // Bannissement : le joueur visé ne peut plus se connecter au jeu (durée vide = définitif).
  const banForm = byId('admin-ban');
  if (banForm) banForm.addEventListener('submit', event => {
    event.preventDefault();
    run(byId('admin-ban-submit'), async () => {
      if (!profile || profile.role !== 'admin') throw new Error('Accès administrateur requis.');
      const target = String(byId('admin-ban-target').value || '').trim();
      if (!target) throw new Error('Indiquez un pseudo de jeu ou une adresse email.');
      const reason = String(byId('admin-ban-reason').value || '').trim();
      const days = byId('admin-ban-days').value;
      const result = await gameRequest('/api/game/ban', { target, ban: true, reason, days });
      if (!result || !result.ok) throw new Error((result && result.error) || 'Bannissement refusé.');
      announce('Joueur banni : ' + target + (days === '' ? ' (définitif)' : ' (' + Number(days) + ' jours)') + (reason ? ' — ' + reason : '') + '.');
      byId('admin-ban-target').value = ''; byId('admin-ban-reason').value = ''; byId('admin-ban-days').value = '';
    });
  });
  const banLift = byId('admin-ban-lift');
  if (banLift) banLift.addEventListener('click', () => run(banLift, async () => {
    if (!profile || profile.role !== 'admin') throw new Error('Accès administrateur requis.');
    const target = String(byId('admin-ban-target').value || '').trim();
    if (!target) throw new Error('Indiquez le pseudo du joueur à débannir.');
    const result = await gameRequest('/api/game/ban', { target, ban: false });
    if (!result || !result.ok) throw new Error((result && result.error) || 'Débannissement refusé.');
    announce('Joueur débanni : ' + target + '.');
    byId('admin-ban-target').value = '';
  }));
  async function init() {
    if (!config?.supabaseUrl || !config?.publishableKey) return;
    try {
      const url = new URL(config.supabaseUrl);
      if (url.protocol !== 'https:' || !/^[a-z0-9-]+\.supabase\.co$/i.test(url.hostname) || url.username || url.password || url.port || url.pathname !== '/' || url.search || url.hash || !/^(sb_publishable_|eyJ)/.test(config.publishableKey)) throw new Error('Utilisez une URL HTTPS Supabase et sa clé publique sb_publishable_. Aucune clé secrète.');
      if (!window.supabase?.createClient) throw new Error('Impossible de charger le service de comptes.');
      // Session enregistrée dans ce navigateur pour rester connecté après un
      // rechargement ; elle se termine avec « Se déconnecter ».
      client = window.supabase.createClient(url.href, config.publishableKey, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
      });
      client.auth.onAuthStateChange((event, session) => {
        ++revision;
        clearPrivateUI();
        window.dispatchEvent(new CustomEvent('recblue:auth', { detail: { event, signedIn: !!session } }));
        setTimeout(() => { refreshAccount().catch(() => announce('Impossible de vérifier la session.')); }, 0);
      });
      byId('account-setup').hidden = true;
      byId('account-controls').disabled = false;
      byId('profile-controls').disabled = false;
      await refreshAccount();
    } catch (error) { announce(error.message); }
  }
  // ---- Mot de passe oublié ----------------------------------------------------
  // Le lien part vers l’adresse enregistrée sur le compte : un compte créé avec un seul
  // pseudo porte une adresse technique qui ne reçoit rien, d’où le renvoi vers Mon compte
  // pour en ajouter une.
  const forgotForm = byId('account-forgot');
  byId('forgot-open')?.addEventListener('click', () => {
    if (!forgotForm) return;
    forgotForm.hidden = false;
    byId('account-login').hidden = true;
    byId('forgot-email').focus();
  });
  byId('forgot-cancel')?.addEventListener('click', () => {
    if (!forgotForm) return;
    forgotForm.hidden = true;
    byId('account-login').hidden = false;
  });
  forgotForm?.addEventListener('submit', event => {
    event.preventDefault();
    run(byId('forgot-submit'), async () => {
      const email = byId('forgot-email').value.trim().toLowerCase();
      if (!email.includes('@')) throw new Error('Indiquez l’adresse email enregistrée sur le compte.');
      const { error } = await client.auth.resetPasswordForEmail(email, {
        redirectTo: (config?.siteOrigin || 'https://recblue.net') + '/compte.html?reset=1'
      });
      if (error) throw error;
      announce('Si un compte utilise ' + email + ', un lien de réinitialisation vient de partir. Vérifiez aussi les indésirables.');
    });
  });

  byId('account-login').addEventListener('submit', event => {
    event.preventDefault();
    run(byId('login-submit'), async () => {
      const identifier = byId('login-identifier').value.trim();
      const password = byId('login-password').value;
      byId('login-password').value = '';
      if (!identifier) throw new Error('Indiquez votre pseudo ou votre adresse email.');
      if (!password) throw new Error('Indiquez votre mot de passe.');
      // Un « @ » indique un compte inscrit avec une adresse email.
      const email = identifier.includes('@') ? identifier.toLowerCase() : pseudoEmail(checkPseudo(identifier));
      let attempt;
      try {
        attempt = await client.auth.signInWithPassword({ email, password });
      } catch (failure) {
        // Réseau coupé, VPN ou bloqueur : la requête n’a même pas abouti.
        throw new Error('Le site n’a pas pu joindre le service de comptes (' + ((failure && failure.message) || 'réseau bloqué') + '). Vérifiez votre connexion internet, coupez un VPN ou un bloqueur de publicité, puis réessayez.');
      }
      const { error } = attempt;
      if (error) {
        const code = String(error.code || error.name || '');
        const detail = String(error.message || '');
        if (error.status === 429 || code === 'over_request_rate_limit' || /rate limit/i.test(detail)) {
          throw new Error('Trop de tentatives de connexion : patientez une minute et réessayez.');
        }
        if (code === 'email_not_confirmed' || /email not confirmed/i.test(detail)) {
          throw new Error('L’email de ce compte n’a jamais été confirmé : connectez-vous avec votre pseudo, ou demandez à un administrateur de confirmer le compte.');
        }
        if (/aal|mfa|totp|factor/i.test(code + ' ' + detail)) {
          throw new Error('Ce compte exige un code de double authentification : ouvrez « Mon espace compte » pour le saisir.');
        }
        if (code === 'invalid_credentials' || /invalid login credentials/i.test(detail)) {
          throw new Error('Mot de passe incorrect, ou aucun compte sous « ' + email + ' ». Si vous vous êtes inscrit avec un email, utilisez cet email à la place du pseudo.');
        }
        if (!navigator.onLine || !error.status || /fetch|network|timeout/i.test(code + ' ' + detail)) {
          throw new Error(!navigator.onLine
            ? 'Ce navigateur est hors connexion : rétablissez internet puis réessayez.'
            : 'Le site n’a pas pu joindre le service de comptes (' + (detail || code || 'réseau bloqué') + '). Vérifiez internet, coupez un VPN ou un bloqueur de publicité, puis réessayez.');
        }
        throw new Error('Connexion refusée par le service (' + (code || 'sans code') + ', statut ' + (error.status || 'inconnu') + ') : ' + (detail || 'réessayez dans un instant.'));
      }
      if (await mfaPending()) { showMfaPrompt('Un code est déjà exigé pour ce compte : saisissez-le pour terminer la connexion.'); return; }
      announce('Connexion réussie.'); await refreshAccount();
    });
  });
  byId('account-signup').addEventListener('submit', event => {
    event.preventDefault();
    run(byId('signup-submit'), async () => {
      const pseudo = checkPseudo(byId('signup-pseudo').value);
      const password = byId('signup-password').value;
      byId('signup-password').value = '';
      const { data, error } = await client.auth.signUp({ email: pseudoEmail(pseudo), password });
      if (error) {
        if (error.code === 'user_already_exists' || /already/i.test(error.message || '')) throw new Error('Ce pseudo est déjà pris. Choisissez-en un autre.');
        if (error.code === 'over_email_send_rate_limit' || /rate limit/i.test(error.message || '')) throw new Error('Trop d’inscriptions coup sur coup : réessayez dans quelques minutes.');
        if (error.code === 'weak_password' || /password/i.test(error.message || '')) throw new Error('Mot de passe refusé : choisissez-en un d’au moins 12 caractères.');
        throw new Error('Inscription impossible : ' + (error.message || 'service indisponible.'));
      }
      if (!data.session) throw new Error('Inscription non activée côté service : la confirmation email de Supabase doit être désactivée (Authentication, Sign In / Providers, Email).');
      const { error: nameError } = await client.from('recblue_accounts')
        .update({ display_name: pseudo }).eq('id', data.user.id).select('id').single();
      // Le compte du JEU, avec le même pseudo et le même mot de passe : c'est ce qui permet
      // de se connecter dans Rec Room juste après l'inscription sur le site.
      let gameNote = '';
      try {
        const game = await fetch('api/game/signup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + data.session.access_token },
          body: JSON.stringify({ pseudo, password })
        });
        const result = await game.json().catch(() => ({}));
        if (game.ok && result && result.ok) {
          gameNote = result.renamed
            ? ' Votre compte de jeu est prêt : connectez-vous dans Rec Room avec « ' + pseudo + ' » et ce mot de passe.'
            : ' Compte de jeu créé, mais ' + (result.warning || 'le pseudo en jeu n’a pas pu être appliqué.');
        } else {
          gameNote = ' Compte de jeu non créé : ' + ((result && result.error) || 'serveur de jeu indisponible') + ' — signale-le à un administrateur.';
        }
      } catch (failure) {
        gameNote = ' Compte de jeu non créé : serveur de jeu injoignable.';
      }
      announce((nameError ? 'Compte créé : vous êtes connecté, modifiez votre pseudo dans votre profil.' : 'Compte créé avec le rôle membre : vous êtes connecté.') + gameNote);
      await refreshAccount();
    });
  });
  byId('account-profile-form').addEventListener('submit', event => {
    event.preventDefault();
    run(byId('profile-submit'), async () => {
      if (!profile) throw new Error('Profil non disponible.');
      const name = byId('account-name').value.trim();
      if (name.length < 2 || name.length > 40) throw new Error('Le pseudo doit contenir entre 2 et 40 caractères.');
      const { data, error } = await client.from('recblue_accounts').update({ display_name: name }).eq('id', profile.id).select('id').single();
      if (error || !data) throw new Error('Modification refusée. Reconnectez-vous et réessayez.');
      announce('Pseudo enregistré.'); await refreshAccount();
    });
  });
  byId('account-logout').addEventListener('click', () => run(byId('account-logout'), async () => {
    const { error } = await client.auth.signOut({ scope: 'local' });
    if (error) throw new Error('Déconnexion impossible. Réessayez.');
    ++revision; clearPrivateUI(); byId('account-guest').hidden = false; announce('Vous êtes déconnecté.');
  }));
  byId('account-mfa-form').addEventListener('submit', event => {
    event.preventDefault();
    run(byId('mfa-submit'), async () => {
      const code = byId('mfa-code').value.trim();
      byId('mfa-code').value = '';
      if (!/^\d{6}$/.test(code)) throw new Error('Le code doit contenir 6 chiffres.');
      const list = await client.auth.mfa.listFactors();
      if (list.error) throw list.error;
      const all = list.data.all || [];
      const totp = all.find(factor => factor.factor_type === 'totp' && factor.status === 'verified');
      const phone = all.find(factor => factor.factor_type === 'phone' && factor.status === 'verified');
      if (!totp && !phone) throw new Error('Aucun facteur 2FA disponible pour ce compte.');
      let error;
      if (totp) ({ error } = await client.auth.mfa.challengeAndVerify({ factorId: totp.id, code }));
      else {
        if (!mfaChallengeId) {
          const challenge = await client.auth.mfa.challenge({ factorId: phone.id });
          if (challenge.error) throw challenge.error;
          mfaChallengeId = challenge.data.id;
          throw new Error('Un code vient d’être envoyé par SMS : saisissez-le ici.');
        }
        ({ error } = await client.auth.mfa.verify({ factorId: phone.id, challengeId: mfaChallengeId, code }));
      }
      if (error) throw new Error('Code refusé ou expiré. Réessayez.');
      mfaChallengeId = '';
      byId('account-mfa').hidden = true;
      announce('Vérification réussie.');
      await refreshAccount();
    });
  });
  byId('accounts-refresh').addEventListener('click', () => run(byId('accounts-refresh'), listAccounts));
  init();
})();
