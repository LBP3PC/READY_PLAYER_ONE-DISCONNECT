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

