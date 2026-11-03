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

  async function token() {
    if (!client) return '';
    const { data } = await client.auth.getSession();
    return (data && data.session && data.session.access_token) || '';
  }

  async function call(payload, accessToken) {
    const response = await fetch('api/paypal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + accessToken },
      body: JSON.stringify(payload)
    });
    const data = await response.json().catch(() => ({}));
    return { ok: response.ok, status: response.status, data };
  }

  function showBalance(total) {
    const value = Number(total) || 0;
    const pill = byId('nav-credits');
    if (pill) {
      const text = value.toLocaleString('fr-FR') + (value === 1 ? ' crédit' : ' crédits');
      const label = byId('nav-credits-value');
      if (label) label.textContent = text;
      else pill.textContent = text;
      pill.hidden = false;
    }
    const card = byId('credits-balance');
    if (card) card.textContent = value.toLocaleString('fr-FR');
  }

  async function buy(pack, button) {
    const accessToken = await token();
    if (!accessToken) {
      say('Connectez-vous d’abord : ouvrez « Mon compte REC BLUE » pour acheter des crédits.');
      const dialog = byId('connexion');
      if (dialog && !dialog.open) dialog.showModal();
      const field = byId('login-identifier');
      if (field) field.focus();
      return;
    }
    const label = button.textContent;
    button.disabled = true;
    button.textContent = 'Ouverture de PayPal…';
    say('Préparation du paiement sécurisé…');
    try {
      const { ok, data } = await call({ action: 'create', pack }, accessToken);
      if (!ok || !data.approveUrl) throw new Error(data.error || 'Le paiement n’est pas disponible pour le moment.');
      sessionStorage.setItem('recblue.paypal.pending', pack);
      say('Redirection vers PayPal…');
      location.assign(data.approveUrl);
    } catch (error) {
      say(error.message || 'Paiement impossible pour le moment.');
      button.disabled = false;
      button.textContent = label;
    }
  }

  document.addEventListener('click', event => {
    const button = event.target.closest('[data-pack]');
    if (!button) return;
    event.preventDefault();
    buy(button.getAttribute('data-pack'), button);
  });

  async function finish() {
    const params = new URLSearchParams(location.search);
    const stage = params.get('paypal');
    if (!stage) return;
    const orderId = String(params.get('token') || params.get('orderId') || '').trim();
    const dialog = byId('boutique');
    const openShop = () => { if (dialog && !dialog.open) dialog.showModal(); };
    const clean = () => history.replaceState(null, '', location.pathname + '#boutique');

    if (stage === 'annule') {
      openShop();
      say('Paiement annulé : aucun crédit n’a été débité.');
      clean();
      return;
    }
    if (stage !== 'retour') return;

    openShop();
    if (!orderId) { say('Réponse PayPal incomplète : aucun crédit n’a été ajouté.'); clean(); return; }
    const accessToken = await token();
    if (!accessToken) {
      say('Reconnectez-vous : le paiement n’a pas encore été vérifié. Gardez le numéro de commande ' + orderId + '.');
      return;
    }
    say('Vérification du paiement auprès de PayPal…');
    const { ok, data } = await call({ action: 'capture', orderId }, accessToken);
    if (!ok) {
      say(data.error || 'Paiement non confirmé. Gardez le numéro de commande ' + orderId + ' et contactez un administrateur.');
      return;
    }
    showBalance(data.credits);
    const added = Number(data.added) || 0;
    say('Payé ! ' + added.toLocaleString('fr-FR') + (added === 1 ? ' crédit ajouté' : ' crédits ajoutés') + ' à votre compte.');
    sessionStorage.removeItem('recblue.paypal.pending');
    clean();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', finish);
  else finish();
})();
