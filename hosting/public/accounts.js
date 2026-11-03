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
  const labels = { member: 'Membre', admin: 'Administrateur' };
  const navLink = document.querySelector('a.nav-control[href="#connexion"]');
  const navLabel = byId('nav-account-label');
  const navBubble = byId('nav-avatar');
  const AVATAR = /^data:image\/(png|jpeg|webp);base64,/;
  // Affiche l’identité du membre dans la barre : bulle de profil + @pseudo.
  const setNavLabel = (label, avatar, plus = false) => {
    if (!navLink) return;
    const signedOut = label === 'Se connecter';
    if (navLabel) {
      navLabel.textContent = label;
      navLabel.classList.toggle('plus-name', !signedOut && plus);
      const navMark = byId('nav-plus');
      if (navMark) navMark.hidden = signedOut || !plus;
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
  function clearPrivateUI() {
    profile = null;
    setNavLabel('Se connecter');
    byId('account-profile').hidden = true;
    byId('account-admin').hidden = true;
    byId('account-users').replaceChildren();
    byId('account-email').textContent = '';
    byId('account-role').textContent = '';
    byId('account-name').value = '';
    const navCredits = byId('nav-credits');
    if (navCredits) { navCredits.hidden = true; navCredits.textContent = ''; }
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
    setNavLabel('@' + (pseudo || profile.display_name), profile.avatar_url, isPlus(profile.plus_until));
    const creditsBadge = byId('nav-credits');
    if (creditsBadge) {
      const total = Number(profile.credits) || 0;
      creditsBadge.textContent = total.toLocaleString('fr-FR') + (total === 1 ? ' crédit' : ' crédits');
      creditsBadge.hidden = false;
    }
    byId('account-name').value = profile.display_name;
    byId('account-role').textContent = labels[profile.role] || 'Droit inconnu';
    const plusBadge = byId('account-plus');
    if (plusBadge) plusBadge.hidden = !isPlus(profile.plus_until);
    byId('account-admin').hidden = profile.role !== 'admin';
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
  async function listAccounts() {
    const result = await client.from('recblue_accounts').select('id,display_name,role,created_at').order('created_at', { ascending: false }).limit(100);
    if (result.error) throw result.error;
    const accounts = result.data;
    await refreshAccount();
    if (!profile || profile.role !== 'admin') throw new Error('Accès administrateur requis.');
    const fragment = document.createDocumentFragment();
    accounts.forEach(account => {
      const row = document.createElement('div'); row.className = 'detail-row';
      const name = document.createElement('span'); name.textContent = account.display_name; name.dataset.noTranslate = '';
      const id = document.createElement('small'); id.textContent = account.id; name.append(id);
      const select = document.createElement('select'); select.className = 'language-select'; select.setAttribute('aria-label', 'Droits de ' + account.display_name);
      Object.entries(labels).forEach(([value, label]) => { const option = document.createElement('option'); option.value = value; option.textContent = label; select.append(option); });
      select.value = account.role;
      const save = document.createElement('button'); save.type = 'button'; save.className = 'button'; save.textContent = 'Appliquer';
      save.addEventListener('click', () => run(save, async () => {
        const { error } = await client.rpc('recblue_set_role', { target_id: account.id, new_role: select.value });
        if (error) { await refreshAccount(); throw error; }
        announce('Droits mis à jour.');
        await refreshAccount();
        if (profile?.role === 'admin') await listAccounts();
      }));
      row.append(name, select, save); fragment.append(row);
    });
    byId('account-users').replaceChildren(fragment);
  }
  const creditsForm = byId('admin-credits');
  if (creditsForm) creditsForm.addEventListener('submit', event => {
    event.preventDefault();
    run(byId('admin-credits-submit'), async () => {
      if (!profile || profile.role !== 'admin') throw new Error('Accès administrateur requis.');
      const target = byId('admin-credits-target').value.trim();
      const amount = Number(byId('admin-credits-amount').value);
      if (!target) throw new Error('Indiquez un pseudo ou une adresse email.');
      if (!Number.isInteger(amount) || amount < 1) throw new Error('Indiquez un nombre de crédits entier, au moins 1.');
      const { data, error } = await client.rpc('recblue_grant_credits', { p_identifier: target, p_amount: amount });
      if (error) throw error;
      announce('Crédits ajoutés à ' + target + ' : nouveau solde ' + Number(data).toLocaleString('fr-FR') + '.');
      byId('admin-credits-amount').value = '';
      await refreshAccount();
    });
  });
  async function init() {
    if (!config?.supabaseUrl || !config?.publishableKey) return;
    try {
      const url = new URL(config.supabaseUrl);
      if (url.protocol !== 'https:' || !/^[a-z0-9-]+\.supabase\.co$/i.test(url.hostname) || url.username || url.password || url.port || url.pathname !== '/' || url.search || url.hash || !config.publishableKey.startsWith('sb_publishable_')) throw new Error('Utilisez une URL HTTPS Supabase et sa clé publique sb_publishable_. Aucune clé secrète.');
      if (!window.supabase?.createClient) throw new Error('Impossible de charger le service de comptes.');
      // Session enregistrée dans ce navigateur pour rester connecté après un
      // rechargement ; elle se termine avec « Se déconnecter ».
      client = window.supabase.createClient(url.href, config.publishableKey, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
      });
      client.auth.onAuthStateChange(() => {
        ++revision;
        clearPrivateUI();
        setTimeout(() => { refreshAccount().catch(() => announce('Impossible de vérifier la session.')); }, 0);
      });
      byId('account-setup').hidden = true;
      byId('account-controls').disabled = false;
      byId('profile-controls').disabled = false;
      await refreshAccount();
    } catch (error) { announce(error.message); }
  }
  byId('account-login').addEventListener('submit', event => {
    event.preventDefault();
    run(byId('login-submit'), async () => {
      const identifier = byId('login-identifier').value;
      const password = byId('login-password').value;
      byId('login-password').value = '';
      // Un « @ » indique un ancien compte inscrit avec une adresse email.
      const email = identifier.includes('@') ? identifier.trim() : pseudoEmail(checkPseudo(identifier));
      const { error } = await client.auth.signInWithPassword({ email, password });
      if (error) {
        if (error.status === 429 || error.code === 'over_request_rate_limit') throw new Error('Trop de tentatives de connexion : patientez une minute et réessayez.');
        if (error.code === 'email_not_confirmed') throw new Error('Ce compte doit être confirmé par email : demandez à un administrateur, ou utilisez un compte par pseudo.');
        throw new Error('Connexion refusée. Vérifiez votre pseudo (ou email) et votre mot de passe.');
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
      announce(nameError ? 'Compte créé : vous êtes connecté, modifiez votre pseudo dans votre profil.' : 'Compte créé avec le rôle membre : vous êtes connecté.');
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
