(() => {
  const byId = id => document.getElementById(id);
  const msg = byId('msg');
  const config = window.RECBLUE_ACCOUNTS;
  const PSEUDO_DOMAIN = 'players.recblue.invalid';
  const PSEUDO_PATTERN = /^[a-z0-9_][a-z0-9_-]{2,19}$/;
  const labels = { member: 'Membre', admin: 'Administrateur' };
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
  function applyAvatar() {
    const element = byId('avatar');
    const url = profile?.avatar_url;
    if (typeof url === 'string' && AVATAR_PATTERN.test(url)) {
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
  function showGuest() {
    user = null; profile = null;
    byId('member').hidden = true;
    byId('guest').hidden = false;
  }
  async function loadProfile() {
    const current = ++revision;
    const { data, error } = await client.auth.getUser();
    if (current !== revision) return;
    if (error || !data.user) { showGuest(); return; }
    user = data.user;
    try {
      const soldeAvant2FA = await client.from('recblue_accounts').select('credits').eq('id', user.id).single();
      const montant = (Number(soldeAvant2FA.data?.credits) || 0).toLocaleString('fr-FR') + ' crédits';
      const gateSolde = byId('gate-credits');
      if (gateSolde) gateSolde.textContent = 'Solde actuel : ' + montant;
    } catch (error) { /* solde indisponible */ }
    if (await needsMfa()) {
      try { await loadFactors(); } catch (error) { /* liste 2FA indisponible */ }
      showGate();
      return;
    }
    const result = await client.from('recblue_accounts').select('id,display_name,role,created_at,avatar_url,contact_email,credits').eq('id', user.id).single();
    if (current !== revision) return;
    if (result.error) { showGuest(); say('Profil inaccessible. Vérifiez la configuration SQL.'); return; }
    profile = result.data;
    const pseudo = pseudoOf(user.email);
    byId('guest').hidden = true;
    byId('member').hidden = false;
    applyAvatar();
    byId('side-name').textContent = profile.display_name;
    const solde = byId('credits-balance');
    if (solde) solde.textContent = (Number(profile.credits) || 0).toLocaleString('fr-FR');
    byId('side-login').textContent = pseudo ? '@' + pseudo : (user.email || '—');
    const role = byId('side-role');
    role.textContent = labels[profile.role] || 'Droit inconnu';
    role.className = 'badge' + (profile.role === 'admin' ? ' admin' : '');
    byId('side-created').textContent = formatDate(profile.created_at);
    byId('side-id').textContent = String(user.id).slice(0, 8) + '…';
    byId('side-email').textContent = profile.contact_email || '—';
    byId('contact-email').value = profile.contact_email || '';
    byId('name').value = profile.display_name;
    byId('admin').hidden = profile.role !== 'admin';
    byId('admin-users').replaceChildren();
    try { await loadFactors(); } catch (error) { byId('mfa-state').textContent = 'État de la double authentification indisponible.'; }
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
      apply.addEventListener('click', () => guard(apply, async () => {
        const { error } = await client.rpc('recblue_set_role', { target_id: account.id, new_role: select.value });
        if (error) throw error;
        say('Droits mis à jour pour ' + account.display_name + '.');
        await loadProfile();
        if (profile?.role === 'admin') await listUsers();
      }));
      row.append(info, select, apply);
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
      const { error } = await client.auth.signInWithPassword({ email, password });
      if (error) throw new Error('Connexion refusée. Vérifiez le pseudo (ou l’email) et le mot de passe.');
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
      if (!PSEUDO_PATTERN.test(pseudo)) throw new Error('Pseudo invalide : 3 à 20 lettres, chiffres, tiret ou souligné.');
      const { data, error } = await client.auth.signUp({ email: pseudo + '@' + PSEUDO_DOMAIN, password });
      if (error) {
        if (error.code === 'user_already_exists' || /already/i.test(error.message || '')) throw new Error('Ce pseudo est déjà pris.');
        if (error.code === 'over_email_send_rate_limit' || /rate limit/i.test(error.message || '')) throw new Error('Trop d’inscriptions coup sur coup : réessayez dans quelques minutes.');
        if (error.code === 'weak_password' || /password/i.test(error.message || '')) throw new Error('Mot de passe refusé : choisissez-en un d’au moins 12 caractères.');
        throw new Error('Inscription impossible : ' + (error.message || 'service indisponible.'));
      }
      if (!data.session) throw new Error('Inscription non activée : la confirmation email de Supabase doit être désactivée.');
      await client.from('recblue_accounts').update({ display_name: pseudo }).eq('id', data.user.id).select('id').single();
      say('Compte créé avec le rôle membre.');
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
      say('Mot de passe modifié. Il sera demandé à la prochaine connexion.');
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

  byId('lang').addEventListener('change', () => { savePref('recblue.language', byId('lang').value); document.documentElement.lang = byId('lang').value; say('Langue enregistrée pour ce navigateur.'); });
  byId('music').addEventListener('change', () => { savePref('recblue.musicOff', String(!byId('music').checked)); say(byId('music').checked ? 'Musique activée sur ce navigateur.' : 'Musique désactivée sur ce navigateur.'); });
  byId('pings').addEventListener('change', () => { savePref('recblue.updatePings', String(byId('pings').checked)); say('Préférence de notifications enregistrée.'); });

  byId('reset-request').addEventListener('submit', event => {
    event.preventDefault();
    guard(event.submitter, async () => {
      const pseudo = byId('reset-pseudo').value.trim().toLowerCase();
      const email = byId('reset-email').value.trim().toLowerCase();
      const message = byId('reset-message').value.trim();
      if (!PSEUDO_PATTERN.test(pseudo)) throw new Error('Pseudo invalide : 3 à 20 lettres, chiffres, tiret ou souligné.');
      if (email && !/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/.test(email)) throw new Error('Adresse email de contact invalide.');
      const { error } = await client.from('recblue_reset_requests').insert({ pseudo, contact_email: email || null, message: message || null });
      if (error) throw new Error('Demande non envoyée : ' + (error.message || 'réessayez plus tard.'));
      byId('reset-request').reset();
      say('Demande envoyée : un administrateur réinitialisera votre mot de passe.');
    });
  });
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

  async function init() {
    if (!config?.supabaseUrl || !config?.publishableKey) { say('Service de comptes non configuré.'); return; }
    try {
      const url = new URL(config.supabaseUrl);
      if (url.protocol !== 'https:' || !/^[a-z0-9-]+\.supabase\.co$/i.test(url.hostname) || !config.publishableKey.startsWith('sb_publishable_')) throw new Error('Configuration Supabase invalide.');
      if (!window.supabase?.createClient) throw new Error('Service de comptes indisponible.');
      client = window.supabase.createClient(url.href, config.publishableKey, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
      client.auth.onAuthStateChange(() => { loadProfile().catch(() => say('Session non vérifiée.')); });
      byId('lang').value = readPref('recblue.language', 'fr');
      byId('music').checked = readPref('recblue.musicOff', 'false') !== 'true';
      byId('pings').checked = readPref('recblue.updatePings', 'false') === 'true';
      await loadProfile();
    } catch (error) { say(error.message); }
  }
  init();
})();
