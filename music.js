(() => {
  const audio = document.getElementById('site-music');
  const button = document.getElementById('music-toggle');
  if (!audio || !button) return;
  const labels = playing => playing ? 'Mettre la musique en pause' : 'Activer la musique';
  audio.addEventListener('loadedmetadata', () => { button.hidden = false; });
  // Fichier absent ou illisible : le bouton reste caché, aucun élément cassé.
  audio.addEventListener('error', () => { button.hidden = true; });
  audio.addEventListener('play', () => {
    button.textContent = '❚❚';
    button.setAttribute('aria-pressed', 'true');
    button.setAttribute('aria-label', labels(true));
  });
  audio.addEventListener('pause', () => {
    button.textContent = '♪';
    button.setAttribute('aria-pressed', 'false');
    button.setAttribute('aria-label', labels(false));
  });
  button.addEventListener('click', async () => {
    try {
      if (audio.paused) await audio.play();
      else audio.pause();
    } catch (error) {
      button.hidden = true;
    }
  });
  button.setAttribute('aria-label', labels(false));
})();
