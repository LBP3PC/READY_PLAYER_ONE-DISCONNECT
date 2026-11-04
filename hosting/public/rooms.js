(() => {
  // Les trois photos ^DormRoom restent affichées tant que les deux nouvelles
  // photos du jeu n'existent pas : la section n'est jamais vide. Dès qu'une
  // nouvelle photo est disponible, les anciennes cartes disparaissent.
  const cards = Array.from(document.querySelectorAll('.room-list .room'));
  const fresh = cards.filter(card => !card.hasAttribute('data-replaced'));
  const replaced = cards.filter(card => card.hasAttribute('data-replaced'));
  if (!fresh.length) return;

  const settle = () => {
    let ready = 0;
    fresh.forEach(card => {
      const img = card.querySelector('img');
      const loaded = !!img && img.complete && img.naturalWidth > 0;
      card.hidden = !loaded;
      if (loaded) ready += 1;
    });
    replaced.forEach(card => { card.hidden = ready > 0; });
  };

  fresh.forEach(card => {
    const img = card.querySelector('img');
    if (!img || img.complete) return;
    img.addEventListener('load', settle, { once: true });
    img.addEventListener('error', settle, { once: true });
  });

  settle();
})();
