(() => {
  // Chambre vedette sans photo : on masque la carte au lieu d'afficher une
  // image cassée. Elle apparaît automatiquement dès que le fichier existe.
  const hide = img => {
    const card = img.closest('.room');
    if (card) card.hidden = true;
  };
  document.querySelectorAll('.room-list img').forEach(img => {
    if (img.complete && img.naturalWidth === 0) { hide(img); return; }
    img.addEventListener('error', () => hide(img), { once: true });
  });
})();
