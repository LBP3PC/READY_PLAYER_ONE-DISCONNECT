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
  const say = text => { msg.textContent = text; };
  const pseudoOf = email => {
    const value = String(email || '').toLowerCase();
    const suffix = '@' + PSEUDO_DOMAIN;
    return value.endsWith(suffix) ? value.slice(0, -suffix.length) : '';
  };
  const readPref = (key, fallback) => { try { return localStorage.getItem(key) ?? fallback; } catch (error) { return fallback; } };
  const savePref = (key, value) => { try { localStorage.setItem(key, value); } catch (error) { /* stockage indisponible */ } };
  const initials = name => String(name || '?').trim().slice(0, 2).toUpperCase();
  const formatDate = value => {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString('fr-FR', { day: '2-digit', month: 'long', year: 'numeric' });
  };
  async function guard(button, action) {
    if (button) button.disabled = true;
    try { await action(); } catch (error) { say(error.message || 'Action impossible. Réessayez.'); }
    finally { if (button) button.disabled = false; }
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
    const result = await client.from('recblue_accounts').select('id,display_name,role,created_at').eq('id', user.id).single();
    if (current !== revision) return;
    if (result.error) { showGuest(); say('Profil inaccessible. Vérifiez la configuration SQL.'); return; }
    profile = result.data;
    const pseudo = pseudoOf(user.email);
    byId('guest').hidden = true;
    byId('member').hidden = false;
    byId('avatar').textContent = initials(profile.display_name);
    byId('side-name').textContent = profile.display_name;
    byId('side-login').textContent = pseudo ? '@' + pseudo : (user.email || '—');
    const role = byId('side-role');
    role.textContent = labels[profile.role] || 'Droit inconnu';
    role.className = 'badge' + (profile.role === 'admin' ? ' admin' : '');
    byId('side-created').textContent = formatDate(profile.created_at);
    byId('side-id').textContent = String(user.id).slice(0, 8) + '…';
    byId('name').value = profile.display_name;
    byId('admin').hidden = profile.role !== 'admin';
    byId('admin-users').replaceChildren();
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
      say('Connexion réussie.');
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
        throw new Error('Inscription impossible. Vérifiez le mot de passe et réessayez.');
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
