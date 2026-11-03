(() => {
  const banner = document.getElementById('early-access-notice');
  const button = document.getElementById('notice-close');
  if (!banner || !button) return;
  const KEY = 'recblue.noticeClosed';
  let closed = false;
  try { closed = localStorage.getItem(KEY) === 'true'; } catch (error) { closed = false; }
  if (closed) { banner.hidden = true; return; }
  button.addEventListener('click', () => {
    banner.hidden = true;
    try { localStorage.setItem(KEY, 'true'); } catch (error) { /* stockage indisponible */ }
  });
})();
