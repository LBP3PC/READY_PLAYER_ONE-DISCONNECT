// Personnalisation du site : couleur d'accent choisie par le joueur, gardée sur CET
// appareil (localStorage) et appliquée à toutes les pages. Aucune donnée n'est envoyée
// au serveur : c'est un réglage d'affichage, pas un attribut de compte.
(() => {
  const KEY = 'recblue-accent';
  const ACCENTS = {
    bleu: '#2445b8',
    cyan: '#0f8ecf',
    violet: '#7a4bd8',
    vert: '#1f9d63',
    orange: '#d97518',
    rose: '#c93a72'
  };
  const read = () => {
    try {
      const value = localStorage.getItem(KEY);
      return value && ACCENTS[value] ? value : 'bleu';
    } catch (error) {
      return 'bleu';
    }
  };
  const apply = name => {
    const chosen = ACCENTS[name] ? name : 'bleu';
    document.documentElement.style.setProperty('--blue', ACCENTS[chosen]);
    document.documentElement.dataset.accent = chosen;
  };
  apply(read());
  window.recblueTheme = {
    accents: ACCENTS,
    current: read,
    set: name => {
      const chosen = ACCENTS[name] ? name : 'bleu';
      try { localStorage.setItem(KEY, chosen); } catch (error) { /* stockage indisponible */ }
      apply(chosen);
      return chosen;
    }
  };
})();
