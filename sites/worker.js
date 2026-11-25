'use strict';

// REC BLUE — hébergement alternatif « Sites » : assets + boutique gratuite.
//
// Le paiement a été retiré. La réclamation gratuite est traitée par le
// Worker principal de recblue.net (même compte, même pack, une fois par compte) ;
// cet hébergement ne fait que relayer la requête, sans aucune clé de paiement.

const json = (status, body) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
});

const SHOP_ORIGIN = 'https://recblue.net';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/shop/claim' || url.pathname === '/api/shop/claim/') {
      try {
        const target = new URL(url.pathname + url.search, SHOP_ORIGIN);
        return await fetch(new Request(target.toString(), request));
      } catch (error) {
        console.error('shop proxy', String(error && error.message ? error.message : error));
        return json(502, { error: 'La boutique gratuite est momentanément indisponible.' });
      }
    }

    // L'annuaire est calculé par le Worker principal, qui garde le jeton du jeu côté
    // serveur. Cet hébergement ne fait que relayer la lecture publique.
    if (url.pathname === '/api/community/players' || url.pathname === '/api/community/players/') {
      try {
        const target = new URL(url.pathname + url.search, SHOP_ORIGIN);
        return await fetch(new Request(target.toString(), request));
      } catch (error) {
        console.error('community proxy', String(error && error.message ? error.message : error));
        return json(502, { error: 'L’annuaire des joueurs est momentanément indisponible.' });
      }
    }

    // Le like d'un profil est traité par le Worker principal, qui vérifie le jeton
    // Supabase et parle au jeu. Le relais garde le corps et l'en-tête Authorization.
    if (url.pathname === '/api/community/like' || url.pathname === '/api/community/like/') {
      try {
        const target = new URL(url.pathname + url.search, SHOP_ORIGIN);
        return await fetch(new Request(target.toString(), request));
      } catch (error) {
        console.error('community like proxy', String(error && error.message ? error.message : error));
        return json(502, { error: 'Les likes sont momentanément indisponibles.' });
      }
    }

    return env.ASSETS.fetch(request);
  }
};
