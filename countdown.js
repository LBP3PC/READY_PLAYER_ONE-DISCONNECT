// Compte à rebours de la date de sortie, partagé par l'accueil et l'espace compte.
(() => {
  const nodes = [...document.querySelectorAll('[data-countdown]')];
  if (!nodes.length) return;
  const pad = value => String(value).padStart(2, '0');
  const targets = nodes.map(node => ({
    node,
    value: node.querySelector('strong'),
    time: new Date(node.dataset.countdown).getTime()
  }));
  const tick = () => {
    const now = Date.now();
    targets.forEach(({ node, value, time }) => {
      if (!Number.isFinite(time)) return;
      let left = time - now;
      if (left <= 0) {
        if (value) value.textContent = 'disponible';
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
      if (value && value.textContent !== texte) value.textContent = texte;
      node.setAttribute('aria-label', 'Sortie dans ' + days + ' jours et ' + hours + ' heures');
    });
  };
  tick();
  setInterval(tick, 1000);
})();
