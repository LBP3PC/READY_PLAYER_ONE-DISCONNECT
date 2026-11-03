(() => {
  const byId = id => document.getElementById(id);
  const message = byId('account-message');
  const config = window.RECBLUE_ACCOUNTS;
  let client;
  let profile = null;
  let revision = 0;
  const announce = text => { message.textContent = text; };
  const labels = { member: 'Membre', admin: 'Administrateur' };
  function clearPrivateUI() {
    profile = null;
    byId('account-profile').hidden = true;
    byId('account-admin').hidden = true;
    byId('account-users').replaceChildren();
    byId('account-email').textContent = '';
    byId('account-role').textContent = '';
    byId('account-name').value = '';
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
    byId('account-guest').hidden = true;
    byId('account-profile').hidden = false;
    byId('account-email').textContent = data.user.email || '';
    const result = await client.from('recblue_accounts').select('id,display_name,role').eq('id', data.user.id).single();
    if (current !== revision) return;
    if (result.error) { announce('Profil inaccessible. Vérifiez la configuration SQL et réessayez.'); return; }
    profile = result.data;
    byId('account-name').value = profile.display_name;
    byId('account-role').textContent = labels[profile.role] || 'Droit inconnu';
    byId('account-admin').hidden = profile.role !== 'admin';
  }
  async function run(button, action) {
    button.disabled = true;
    try { await action(); } catch (error) { announce(error.message || 'Service inaccessible. Réessayez.'); }
    finally { button.disabled = false; }
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
  async function init() {
    if (!config?.supabaseUrl || !config?.publishableKey) return;
    try {
      const url = new URL(config.supabaseUrl);
      if (url.protocol !== 'https:' || !/^[a-z0-9-]+\.supabase\.co$/i.test(url.hostname) || url.username || url.password || url.port || url.pathname !== '/' || url.search || url.hash || !config.publishableKey.startsWith('sb_publishable_')) throw new Error('Utilisez une URL HTTPS Supabase et sa clé publique sb_publishable_. Aucune clé secrète.');
      if (!window.supabase?.createClient) throw new Error('Impossible de charger le service de comptes.');
      // Sessions en mémoire uniquement : aucun jeton dans localStorage.
      client = window.supabase.createClient(url.href, config.publishableKey, {
        auth: { persistSession: false, autoRefreshToken: true, detectSessionInUrl: true }
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
      const email = byId('login-email').value.trim();
      const password = byId('login-password').value;
      byId('login-password').value = '';
      const { error } = await client.auth.signInWithPassword({ email, password });
      if (error) throw new Error('Connexion refusée. Vérifiez vos identifiants et la confirmation de votre email.');
      announce('Connexion réussie.'); await refreshAccount();
    });
  });
  byId('account-signup').addEventListener('submit', event => {
    event.preventDefault();
    run(byId('signup-submit'), async () => {
      const email = byId('signup-email').value.trim();
      const password = byId('signup-password').value;
      byId('signup-password').value = '';
      const { data, error } = await client.auth.signUp({ email, password });
      if (error) throw new Error('Inscription impossible. Vérifiez votre email et les règles du mot de passe, puis réessayez.');
      announce(data.session ? 'Compte créé avec le rôle membre.' : 'Si cette adresse peut être inscrite, vous recevrez un email de confirmation.');
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
  byId('accounts-refresh').addEventListener('click', () => run(byId('accounts-refresh'), listAccounts));
  init();
})();
