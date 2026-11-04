(() => {
  // Les chambres vedettes affichées sont les deux photos du jeu. Tant qu'un
  // fichier manque, sa carte reste masquée : jamais d'image cassée.
  document.querySelectorAll('.room-list .room').forEach(card => {
    const img = card.querySelector('img');
    if (!img) return;
    const hide = () => { card.hidden = true; };
    if (img.complete) { if (img.naturalWidth === 0) hide(); return; }
    img.addEventListener('error', hide, { once: true });
  });
})();
