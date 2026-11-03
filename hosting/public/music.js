(() => {
  const audio = document.getElementById('site-music');
  const button = document.getElementById('music-toggle');
  if (!audio || !button) return;
  const labels = playing => playing ? 'Mettre la musique en pause' : 'Activer la musique';
  // L'utilisateur a coupé la musique lui-même : on ne la relance pas tout seul.
  let userPaused = false;
  let waitingForGesture = false;

  const tryPlay = async () => {
    try { await audio.play(); return true; } catch (error) { return false; }
  };

  function unmuteAndClean() {
    audio.muted = false;
    waitingForGesture = false;
    document.removeEventListener('pointerdown', onGesture, true);
    document.removeEventListener('keydown', onGesture, true);
    document.removeEventListener('touchstart', onGesture, true);
  }
  function onGesture() {
    if (!waitingForGesture) return;
    if (audio.paused && !userPaused) audio.play().catch(() => {});
    unmuteAndClean();
  }

  const musicDisabled = () => { try { return localStorage.getItem('recblue.musicOff') === 'true'; } catch (error) { return false; } };

  async function start() {
    if (userPaused || musicDisabled() || !audio.paused) return;
    // 1. Tentative normale, avec son : autorisée si le navigateur le permet.
    if (await tryPlay()) return;
    // 2. Sinon démarrage silencieux (toujours autorisé), puis son dès la
    //    première interaction du visiteur : c'est la seule méthode permise.
    audio.muted = true;
    if (!(await tryPlay())) { audio.muted = false; return; }
    waitingForGesture = true;
    document.addEventListener('pointerdown', onGesture, true);
    document.addEventListener('keydown', onGesture, true);
    document.addEventListener('touchstart', onGesture, true);
  }

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
  audio.addEventListener('error', () => { button.hidden = true; });

  button.addEventListener('click', async () => {
    if (audio.paused) {
      userPaused = false;
      if (waitingForGesture) unmuteAndClean();
      audio.muted = false;
      try { await audio.play(); } catch (error) { button.hidden = true; }
    } else {
      userPaused = true;
      audio.pause();
    }
  });

  button.setAttribute('aria-label', labels(false));
  if (audio.error) { button.hidden = true; return; }
  button.hidden = false;
  if (audio.readyState >= 1) start();
  else audio.addEventListener('loadedmetadata', start, { once: true });
})();
