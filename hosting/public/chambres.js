'use strict';

// La liste des chambres vient du serveur de jeu via /api/game/rooms : le site n'en
// stocke aucune copie. Ce qu'on publie en jeu apparaît donc ici, et disparaît si la
// chambre est retirée.

const list = document.getElementById('room-list');
const msg = document.getElementById('msg');
const count = document.getElementById('room-count');
const form = document.getElementById('room-search');
const query = document.getElementById('room-query');
const online = document.getElementById('online');
const photoList = document.getElementById('photo-list');
const photosMsg = document.getElementById('photos-msg');

function node(tag, className, value) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (value !== undefined) element.textContent = value;
  return element;
}

function card(room) {
  const box = node('article', 'room-card');
  // La vignette vient du service d'images du jeu : c'est la même que dans le client.
  if (room.image) {
    const thumb = document.createElement('img');
    thumb.className = 'room-thumb';
    thumb.src = 'https://img.recblue.net/' + encodeURIComponent(room.image);
    thumb.alt = '';
    thumb.loading = 'lazy';
    thumb.decoding = 'async';
    box.append(thumb);
  }
  const head = node('div', 'room-head');
  head.append(
    node('h2', '', room.name),
    node('span', room.isOfficial ? 'tag official' : 'tag', room.isOfficial ? 'Officielle' : 'Communauté')
  );
  box.append(head);
  if (room.description) box.append(node('p', 'room-desc', room.description));
  const visites = room.visitors === 1 ? '1 visite' : room.visitors + ' visites';
  // Les « likes » sont les cheers du jeu (CheerCount) : le compteur réel de la chambre.
  const likes = Number(room.cheers) || 0;
  const likesTexte = likes === 1 ? '1 like' : likes + ' likes';
  const favorisTotal = Number(room.favorites) || 0;
  const favoris = favorisTotal === 1 ? '1 favori' : favorisTotal + ' favoris';
  box.append(node('p', 'room-facts', visites + ' · 👍 ' + likesTexte + ' · ♥ ' + favoris + ' · ' + room.maxPlayers + ' joueurs max'));
  return box;
}

// Les photos partagées en jeu (photos de chambre) : mêmes images que dans le client.
function photoCard(photo) {
  const box = node('figure', 'photo-card');
  const link = document.createElement('a');
  link.href = photo.url;
  link.target = '_blank';
  link.rel = 'noopener';
  const img = document.createElement('img');
  img.src = photo.url;
  img.alt = photo.room ? 'Photo prise dans ' + photo.room : 'Photo prise en jeu';
  img.loading = 'lazy';
  img.decoding = 'async';
  link.append(img);
  box.append(link);
  const caption = node('figcaption', 'photo-caption');
  caption.textContent = (photo.username ? '@' + photo.username : 'Joueur') + (photo.room ? ' · ' + photo.room : '');
  box.append(caption);
  return box;
}

async function loadPhotos() {
  if (!photoList) return;
  try {
    const response = await fetch('/api/game/photos?take=12', { cache: 'no-store' });
    const body = await response.json().catch(() => null);
    if (!response.ok) throw new Error((body && body.error) || 'statut ' + response.status);
    const photos = (body && body.photos) || [];
    photoList.replaceChildren(...photos.map(photoCard));
    if (photosMsg) photosMsg.textContent = photos.length ? '' : 'Aucune photo partagée en jeu pour l’instant.';
  } catch (error) {
    if (photosMsg) photosMsg.textContent = 'Photos indisponibles : ' + (error.message || 'réseau');
  }
}

async function load(term) {
  msg.textContent = 'Chargement des chambres du jeu…';
  list.setAttribute('aria-busy', 'true');
  try {
    const url = '/api/game/rooms?take=24' + (term ? '&q=' + encodeURIComponent(term) : '');
    const response = await fetch(url, { cache: 'no-store' });
    const body = await response.json().catch(() => null);
    if (!response.ok) throw new Error((body && body.error) || 'statut ' + response.status);
    const rooms = (body && body.rooms) || [];
    list.replaceChildren(...rooms.map(card));
    count.textContent = rooms.length + (rooms.length === 1 ? ' chambre' : ' chambres');
    // Combien de joueurs sont connectés au jeu en ce moment (présences du serveur de jeu).
    const vit = await fetch('/api/game/online', { cache: 'no-store' }).catch(() => null);
    const vitBody = vit ? await vit.json().catch(() => null) : null;
    if (online && vit && vit.ok && vitBody) {
      const joueurs = Number(vitBody.online) || 0;
      online.textContent = joueurs + (joueurs === 1 ? ' joueur connecté au jeu en ce moment' : ' joueurs connectés au jeu en ce moment');
    }
    msg.textContent = rooms.length ? '' : 'Aucune chambre ne correspond à cette recherche.';
  } catch (error) {
    msg.textContent = 'Chambres indisponibles : ' + (error.message || 'réseau');
  } finally {
    list.removeAttribute('aria-busy');
  }
}

form.addEventListener('submit', event => {
  event.preventDefault();
  load(query.value.trim());
});

load('');
loadPhotos();
