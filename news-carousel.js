(() => {
  const track = document.getElementById('news-track');
  const carousel = document.getElementById('news-carousel');
  if (!track || !carousel) return;
  const slides = [...track.querySelectorAll('.news-card')];
  if (slides.length < 2) return;
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
  let index = 0;
  let timer = null;

  const goTo = next => {
    index = (next + slides.length) % slides.length;
    track.scrollTo({
      left: slides[index].offsetLeft - track.offsetLeft,
      behavior: reduce.matches ? 'auto' : 'smooth'
    });
  };
  const stop = () => { if (timer) { clearInterval(timer); timer = null; } };
  const start = () => {
    stop();
    if (reduce.matches) return;
    timer = setInterval(() => goTo(index + 1), 6000);
  };

  carousel.querySelectorAll('[data-news-prev], [data-news-next]').forEach(button => {
    button.addEventListener('click', () => {
      goTo(index + (button.hasAttribute('data-news-next') ? 1 : -1));
      start();
    });
  });
  // Le défilement s'arrête dès que le visiteur survole ou utilise le carrousel.
  ['pointerenter', 'focusin', 'touchstart'].forEach(type => carousel.addEventListener(type, stop, { passive: true }));
  ['pointerleave', 'focusout'].forEach(type => carousel.addEventListener(type, start));
  document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); else start(); });
  start();
})();

// Compte à rebours de la date de sortie affiché sur l'image de maintenance.
(() => {
  const nodes = [...document.querySelectorAll('[data-countdown]')];
  if (!nodes.length) return;
  const pad = value => String(value).padStart(2, '0');
  const targets = nodes.map(node => {
    const value = node.querySelector('.news-countdown-value');
    return { node, value, time: new Date(node.dataset.countdown).getTime() };
  });
  const tick = () => {
    const now = Date.now();
    targets.forEach(({ node, value, time }) => {
      if (!Number.isFinite(time) || !value) return;
      let left = time - now;
      if (left <= 0) {
        value.textContent = 'disponible';
        node.setAttribute('aria-label', 'Le jeu est disponible');
        return;
      }
      const days = Math.floor(left / 86400000);
      left -= days * 86400000;
      const hours = Math.floor(left / 3600000);
      left -= hours * 3600000;
      const mins = Math.floor(left / 60000);
      const secs = Math.floor((left - mins * 60000) / 1000);
      const texte = days + ' j · ' + pad(hours) + ' h · ' + pad(mins) + ' min · ' + pad(secs) + ' s';
      if (value.textContent !== texte) value.textContent = texte;
      node.setAttribute('aria-label', 'Sortie dans ' + days + ' jours et ' + hours + ' heures');
    });
  };
  tick();
  setInterval(tick, 1000);
})();
