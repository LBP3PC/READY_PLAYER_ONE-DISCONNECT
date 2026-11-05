import { handleGameSignup, handleGameCredits, handleGameGrant, handleGamePlus, handleGameBan, handleGameRole, handleGameCertify, handleGameCertified, handleGamePlayers, handleGameAvatar, handleGameRooms, handleGameDebit, handleGameOnline, handleGameStatus, handleGamePhotos } from './game-bridge.js';
import { handlePaypal } from './paypal.js';

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;

    // La boutique : le paiement PayPal tourne ici, pas en fichier statique.
    if (path === '/api/paypal') {
      return handlePaypal(request, env);
    }

    // Le compte du site crée le compte de jeu (même pseudo, même mot de passe).
    if (path === '/api/game/signup') {
      return handleGameSignup(request, env);
    }

    // Le solde affiché sur le site est celui du JEU (un seul nombre pour les deux).
    if (path === '/api/game/credits') {
      return handleGameCredits(request, env);
    }

    // Un don de crédits d'administration crédite aussi le jeu (crédit + box).
    if (path === '/api/game/grant') {
      return handleGameGrant(request, env);
    }

    // REC BLUE Plus (avec sa date de fin) et bannissements : décidés par l'administration,
    // appliqués sur le compte de JEU.
    if (path === '/api/game/plus') {
      return handleGamePlus(request, env);
    }
    if (path === '/api/game/ban') {
      return handleGameBan(request, env);
    }
    // Les droits d'équipe du site (modérateur / administrateur) appliqués au compte de jeu.
    if (path === '/api/game/role') {
      return handleGameRole(request, env);
    }
    // Le badge « Certifié REC BLUE » : accordé par l'administration, lu par le joueur.
    if (path === '/api/game/certify') {
      return handleGameCertify(request, env);
    }
    if (path === '/api/game/certified') {
      return handleGameCertified(request, env);
    }
    // Les comptes du jeu et les joueurs en ligne, pour la page d'administration.
    if (path === '/api/game/players') {
      return handleGamePlayers(request, env);
    }
    // La photo de profil du JEU, affichée sur le site à la place d'une copie.
    if (path === '/api/game/avatar') {
      return handleGameAvatar(request, env);
    }

    // Les chambres du JEU, telles qu'il les publie : le site ne stocke aucune copie.
    if (path === '/api/game/rooms') {
      return handleGameRooms(request, env);
    }

    // Retrait de crédits par l'administration (correction de solde).
    if (path === '/api/game/debit') {
      return handleGameDebit(request, env);
    }

    // Combien de joueurs sont connectés au jeu, en direct.
    if (path === '/api/game/online') {
      return handleGameOnline(request, env);
    }

    // État réel des services du jeu, pour le panneau « Statut ».
    if (path === '/api/game/status') {
      return handleGameStatus(request, env);
    }

    // Les photos prises en jeu, pour la galerie du site.
    if (path === '/api/game/photos') {
      return handleGamePhotos(request, env);
    }

    const response = await env.ASSETS.fetch(request);
    const headers = new Headers(response.headers);
    headers.set('X-Content-Type-Options', 'nosniff');
    headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }
};
