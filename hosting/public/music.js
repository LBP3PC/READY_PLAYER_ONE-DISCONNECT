(() => {
  // Musique du site — mêmes règles sur toutes les pages.
  //
  // Deux clés seulement : `recblue.musicOff` (le réglage des préférences) et
  // `recblue.musicPaused` (le bouton ♪). Les deux bloquent le démarrage automatique, donc
  // une pause faite sur une page reste une pause sur les suivantes. La page précédente est
  // mise en pause à la sortie : sinon elle continuait à jouer en même temps que la nouvelle
  // quand le navigateur la gardait en mémoire, et le bouton pause semblait sans effet.
  const OFF_KEY = 'recblue.musicOff';
  const PAUSED_KEY = 'recblue.musicPaused';
  const POSITION_KEY = 'recblue.musicAt';
  const read = (key, fallback) => {
    try { return localStorage.getItem(key) ?? fallback; } catch (error) { return fallback; }
  };
  const write = (key, value) => {
    try { localStorage.setItem(key, value); } catch (error) { /* stockage indisponible */ }
  };
  const blocked = () => read(OFF_KEY, 'false') === 'true' || read(PAUSED_KEY, 'false') === 'true';

  // Un seul lecteur par page, même si la page en déclare plusieurs.
  const existing = document.querySelectorAll('audio#site-music');
  existing.forEach((element, index) => { if (index > 0) element.remove(); });
  let audio = existing[0] || null;
  if (!audio) {
    audio = document.createElement('audio');
    audio.id = 'site-music';
    audio.src = 'music.mp3?v=3';
    audio.loop = true;
    audio.preload = 'metadata';
    document.body.append(audio);
  }

  let button = document.getElementById('music-toggle');
  if (!button) {
    button = document.createElement('button');
    button.id = 'music-toggle';
    button.type = 'button';
    button.className = 'music-toggle';
    button.textContent = '♪';
    button.style.cssText =
      'position:fixed;right:18px;bottom:18px;z-index:60;width:42px;height:42px;' +
      'border-radius:50%;border:0;cursor:pointer;font:inherit;font-size:18px;' +
      'background:#2445b8;color:#fff;box-shadow:0 8px 20px rgba(0,0,0,.38)';
    document.body.append(button);
  }

  const readPosition = () => {
    try { return Number(sessionStorage.getItem(POSITION_KEY)) || 0; } catch (error) { return 0; }
  };
  const savePosition = () => {
    try { sessionStorage.setItem(POSITION_KEY, String(audio.currentTime || 0)); } catch (error) { /* stockage indisponible */ }
  };

  const labels = playing => playing ? 'Mettre la musique en pause' : 'Activer la musique';
  let userPaused = blocked();
  let waitingForGesture = false;

  function unmuteAndClean() {
    audio.muted = false;
    waitingForGesture = false;
    document.removeEventListener('pointerdown', onGesture, true);
    document.removeEventListener('keydown', onGesture, true);
    document.removeEventListener('touchstart', onGesture, true);
  }
  function onGesture() {
    if (!waitingForGesture) return;
    if (audio.paused && !userPaused && !blocked()) audio.play().catch(() => {});
    unmuteAndClean();
  }

  async function start() {
    if (userPaused || blocked() || !audio.paused) return;
    // 1. Lecture avec son, si le navigateur l'autorise.
    try { await audio.play(); return; } catch (error) { /* autoplay refusé */ }
    // 2. Sinon lecture silencieuse, avec le son dès la première interaction.
    audio.muted = true;
    try { await audio.play(); } catch (error) { audio.muted = false; return; }
    waitingForGesture = true;
    document.addEventListener('pointerdown', onGesture, true);
    document.addEventListener('keydown', onGesture, true);
    document.addEventListener('touchstart', onGesture, true);
  }

  function pauseNow() {
    userPaused = true;
    write(PAUSED_KEY, 'true');
    unmuteAndClean();
    savePosition();
    audio.pause();
  }

  function playNow() {
    userPaused = false;
    write(PAUSED_KEY, 'false');
    audio.muted = false;
    unmuteAndClean();
    audio.play().catch(() => { button.hidden = true; });
  }

  // Reprise à la position quittée sur la page précédente.
  const restore = () => {
    const at = readPosition();
    if (at > 0 && Number.isFinite(audio.duration) && at < audio.duration - 1) audio.currentTime = at;
  };
  if (audio.readyState >= 1) restore();
  else audio.addEventListener('loadedmetadata', restore, { once: true });

  let lastSave = 0;
  audio.addEventListener('timeupdate', () => {
    const now = Date.now();
    if (now - lastSave < 2000) return;
    lastSave = now;
    savePosition();
  });

  // À la sortie de page : on mémorise et on coupe. La page suivante reprend au même point,
  // et une page gardée en mémoire par le navigateur ne joue plus par-dessus.
  window.addEventListener('pagehide', () => {
    savePosition();
    audio.pause();
  });
  window.addEventListener('pageshow', event => {
    if (event.persisted && !userPaused && !blocked() && audio.paused) start();
  });

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

  button.addEventListener('click', () => {
    if (audio.paused) playNow();
    else pauseNow();
  });

  button.setAttribute('aria-label', labels(false));
  if (audio.error) { button.hidden = true; return; }
  button.hidden = false;
  button.setAttribute('aria-pressed', audio.paused ? 'false' : 'true');
  button.textContent = audio.paused ? '♪' : '❚❚';
  if (audio.readyState >= 1) start();
  else audio.addEventListener('loadedmetadata', start, { once: true });
})();
