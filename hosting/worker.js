import { handleGameSignup, handleGameUsernameAvailability, handleGameCredits, handleGameGrant, handleGameAnnounce, handleGamePlus, handleGameBan, handleGameRole, handleGameSiteRole, handleGameSitePlus, handleSiteAccountAdmin, handleGameCertify, handleGameCertified, handleGameDeveloper, handleGamePlayers, handleCommunityPlayers, handleCommunityLike, handleGameAvatar, handleGameRooms, handleGameDebit, handleGameOnline, handleGameStatus, handleGamePhotos } from './game-bridge.js';
import { handleFreeClaim, handleClaimHistory } from './shop.js';
import { handleGameInventory, handleGameShopBuy, handleGameStorefront } from './game-shop.js';
import { handleMaintenanceStatus, handleMaintenanceAdmin, handleMaintenanceAccess } from './maintenance.js';

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;

    // L’ancienne page « Obtenir Rec Room officiellement » est retirée du site : les liens
    // encore indexés renvoient vers l’accueil, pas vers une page morte.
    if (path === '/obtenir-rec-room' || path === '/obtenir-rec-room.html') {
      return Response.redirect(new URL('/', request.url).toString(), 301);
    }

    // La boutique est gratuite : les packs de crédits sont réutilisables, le Plus et
    // le pack de démarrage restent uniques. L’historique est propre au compte connecté.
    if (path === '/api/shop/claim' || path === '/api/shop/claim/') {
      return handleFreeClaim(request, env);
    }
    if (path === '/api/shop/history' || path === '/api/shop/history/') {
      return handleClaimHistory(request, env);
    }

    // Maintenance du jeu : l’état public sert au launcher, le réglage est réservé
    // aux administrateurs, et l’accès vérifie le rôle ou le code d’été.
    if (path === '/api/maintenance/status' || path === '/api/maintenance/status/') {
      return handleMaintenanceStatus(request, env);
    }
    if (path === '/api/maintenance/access' || path === '/api/maintenance/access/') {
      return handleMaintenanceAccess(request, env);
    }
    if (path === '/api/maintenance' || path === '/api/maintenance/') {
      return handleMaintenanceAdmin(request, env);
    }
    // Vérifier le pseudo avant de créer le compte du site.
    if (path === '/api/game/username-availability') {
      return handleGameUsernameAvailability(request, env);
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

    // Message général « Coach » affiché à tous les joueurs connectés dans le jeu.
    if (path === '/api/game/announce') {
      return handleGameAnnounce(request, env);
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
    // Le rôle du SITE écrit en base avec la clé de service, puis le rôle de jeu : un seul
    // appel, pour que les deux ne puissent plus diverger.
    if (path === '/api/game/site-role') {
      return handleGameSiteRole(request, env);
    }
    // La date de fin du REC BLUE Plus écrite en base avec la clé de service, puis en jeu.
    if (path === '/api/game/site-plus') {
      return handleGameSitePlus(request, env);
    }
    // Inspection et nettoyage des fiches du site (serveur uniquement, jeton partagé).
    if (path === '/api/game/site-accounts') {
      return handleSiteAccountAdmin(request, env);
    }
    // Le badge « Certifié REC BLUE » : accordé par l'administration, lu par le joueur.
    if (path === '/api/game/certify') {
      return handleGameCertify(request, env);
    }
    if (path === '/api/game/certified') {
      return handleGameCertified(request, env);
    }
    // Les comptes du jeu et les joueurs en ligne, pour la page d'administration.
    // Le rôle `developer` seul : le badge Créateur/Dev de la plaque de nom.
    if (path === '/api/game/developer') {
      return handleGameDeveloper(request, env);
    }
    if (path === '/api/game/players') {
      return handleGamePlayers(request, env);
    }
    // L'annuaire public de la communauté : aucune donnée privée ne sort d'ici.
    if (path === '/api/community/players' || path === '/api/community/players/') {
      return handleCommunityPlayers(request, env);
    }
    // Like d'un profil : le navigateur envoie seulement son jeton Supabase ; le Worker
    // vérifie le compte, puis transmet au jeu sans exposer le jeton du pont.
    if (path === '/api/community/like' || path === '/api/community/like/') {
      return handleCommunityLike(request, env);
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

    // Boutique et garde-robe du jeu dans l'app : le catalogue est servi avec ce que le
    // joueur possède déjà, et l'achat passe par le pont econ (même débit que le jeu).
    if (path === '/api/game/inventory') {
      return handleGameInventory(request, env);
    }
    if (path === '/api/game/storefront') {
      return handleGameStorefront(request, env);
    }
    if (path === '/api/game/buy') {
      return handleGameShopBuy(request, env);
    }

    const response = await env.ASSETS.fetch(request);
    const headers = new Headers(response.headers);
    headers.set('X-Content-Type-Options', 'nosniff');
    headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }
};
