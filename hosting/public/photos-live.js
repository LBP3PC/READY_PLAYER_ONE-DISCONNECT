// Les photos prises EN JEU, affichées sur le site.
// Le site ne stocke rien : il demande la liste au serveur de jeu et affiche les images
// servies par son CDN. La section « Photos prises en jeu » est visible d'emblée ; la
// galerie du bas reprend les mêmes photos avec les légendes.
(function () {
  const featured = document.getElementById('live-photos');
  const gallery = document.getElementById('photos-grid');
  if (!featured && !gallery) return;

  const featuredCount = document.getElementById('live-photos-count');
  const featuredNote = document.getElementById('live-photos-note');
  const summary = document.getElementById('gallery-summary');
  const count = document.getElementById('photos-count');
  const viewer = document.getElementById('photo-viewer');
  const full = document.getElementById('full-photo');
  const title = document.getElementById('viewer-title');

  function where(photo) {
    return photo.room ? ' dans ' + photo.room : '';
  }

  function card(photo, withCredit) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'photo';
    button.setAttribute('aria-label', 'Agrandir la photo de ' + photo.username + where(photo));

    const image = document.createElement('img');
    image.loading = 'lazy';
    image.decoding = 'async';
    image.src = photo.url;
    image.alt = 'Photo prise en jeu par ' + photo.username + where(photo);
    button.appendChild(image);

    if (withCredit) {
      const credit = document.createElement('span');
      credit.className = 'photo-credit';
      credit.textContent = '@' + photo.username + where(photo);
      button.appendChild(credit);
    }

    button.addEventListener('click', function () {
      if (!viewer || !full) return;
      full.src = photo.url;
      full.alt = image.alt;
      if (title) title.textContent = 'Photo de ' + photo.username + where(photo);
      viewer.showModal();
    });

    return button;
  }

  function fill(target, photos, withCredit) {
    if (!target) return;
    target.replaceChildren.apply(target, photos.map(function (photo) {
      return card(photo, withCredit);
    }));
  }

  function pluriel(n, singulier, plurielMot) {
    return n + (n === 1 ? ' ' + singulier : ' ' + plurielMot);
  }

  fetch('/api/game/photos?take=12', { cache: 'no-store' })
    .then(function (response) { return response.ok ? response.json() : null; })
    .then(function (data) {
      const photos = data && Array.isArray(data.photos) ? data.photos : [];

      // Section mise en avant : les dernières photos, avec le pseudo du joueur en légende.
      if (featured) {
        fill(featured, photos.slice(0, 8), true);
        if (featuredCount) featuredCount.textContent = photos.length ? pluriel(photos.length, 'photo', 'photos') : '';
        if (featuredNote) {
          featuredNote.textContent = photos.length
            ? 'Prises et publiées en jeu par les joueurs. Clique sur une photo pour l’agrandir.'
            : 'Aucune photo publique prise en jeu pour le moment : les photos réglées en privé dans le jeu restent privées.';
        }
      }

      // La galerie du bas garde ses photos actuelles tant qu'aucune photo de jeu n'existe.
      if (photos.length === 0) return;
      fill(gallery, photos.slice(0, 18), false);
      if (count) count.textContent = pluriel(photos.length, 'photo', 'photos');
      if (summary) summary.textContent = 'Ouvrir la galerie · ' + pluriel(photos.length, 'photo', 'photos') + ' prises en jeu';
    })
    .catch(function () {});
})();
