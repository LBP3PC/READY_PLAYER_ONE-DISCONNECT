// Chaque route du pont qui interroge le serveur de jeu passe par `askGame` : elle essaie
// le pseudo, puis le candidat suivant, et s'arrête au premier compte qui existe. Ces tests
// figent les cinq comportements qui comptent, route par route.
//
// Deux façons d'obtenir un second candidat, selon la route :
//   - pseudo de la fiche du site (« joueur ») puis partie locale de l'email (« second ») ;
//   - pseudo demandé (« joueur ») puis nom affiché trouvé côté jeu (« second »).
// Les routes d'administration ne retiennent qu'un candidat quand la cible est un pseudo :
// c'est dit cas par cas (`candidats: 1`).
//
//   node --test hosting/scripts/pont-candidats.test.mjs
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as pont from '../game-bridge.js';

const env = {
  SUPABASE_URL: 'https://site.example',
  SUPABASE_SECRET_KEY: 'service-secret',
  SITE_BRIDGE_TOKEN: 'bridge-secret',
  GAME_ECON_HOST: 'https://econ.example',
  GAME_AUTH_HOST: 'https://auth.example',
  GAME_IMAGES_HOST: 'https://img.example'
};

const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

// Ce que le serveur de jeu renvoie quand il connaît le compte.
const DONNEES = {
  balance: 120,
  giftId: 'g1',
  isModerator: true,
  isDeveloper: false,
  profileImage: 'p/1.png',
  bannerImage: '',
  item: { id: 7, name: 'Chapeau' },
  quantity: 1,
  stacks: false,
  removed: 5
};

/**
 * Le site et le serveur de jeu simules. `plan` contient les reponses du jeu dans l'ordre
 * des candidats ; `'panne'` simule une coupure reseau (fetch qui rejette).
 */
function serveurSimule(plan) {
  const appels = [];
  globalThis.fetch = async (url, init = {}) => {
    const adresse = new URL(url);
    const chemin = adresse.pathname;
    if (chemin === '/auth/v1/user') return json(200, { id: 'user-1', email: 'second@exemple.fr' });
    if (chemin === '/auth/v1/admin/users') {
      return json(200, {
        users: [
          { id: 'fiche-1', email: 'joueur@exemple.fr' },
          { id: 'fiche-2', email: 'second@exemple.fr' }
        ]
      });
    }
    if (chemin === '/internal/site/developer') return json(200, { developer: false });
    if (chemin === '/rest/v1/recblue_accounts') {
      if ((init.method || 'GET') === 'PATCH') return json(200, [{ id: 'fiche-1' }]);
      return json(200, [
        { id: 'fiche-1', display_name: 'joueur', role: 'admin', level: 1, plus_until: '2026-12-31T00:00:00.000Z' }
      ]);
    }
    if (chemin === '/api/site/players') {
      // Un compte dont le NOM AFFICHE est « joueur » : c'est le second candidat.
      return json(200, { players: [{ username: 'second', displayName: 'joueur' }] });
    }
    if (chemin.startsWith('/api/site/')) {
      appels.push(chemin + adresse.search);
      const pas = plan.shift();
      if (pas === undefined) throw new Error('appel inattendu au serveur de jeu : ' + chemin);
      if (pas === 'panne') throw new Error('panne reseau');
      return pas;
    }
    throw new Error('requete inattendue : ' + chemin);
  };
  return appels;
}

const budget = (methode, chemin, corps) =>
  new Request('https://site.example' + chemin, {
    method: methode,
    headers: { authorization: 'Bearer session-du-site', 'content-type': 'application/json' },
    body: corps === undefined ? undefined : JSON.stringify(corps)
  });

const AUCUN_COMPTE = { error: 'Aucun compte de jeu ne correspond à « joueur ».' };
const INJOIGNABLE = { error: 'Le serveur de jeu est injoignable.' };
const refuse = { error: 'Le serveur de jeu a refusé (500).' };
const site = (u) => ({ ok: true, id: u === 'second' ? 'fiche-2' : 'fiche-1' });

const PLANS = {
  succes: () => [json(200, DONNEES)],
  suivant: () => [json(404, {}), json(200, DONNEES)],
  tous404: () => [json(404, {}), json(404, {})],
  refus: () => [json(500, {})],
  panne: () => ['panne']
};

const CAS = [
  {
    nom: 'grant — accorder des crédits',
    // Cible = pseudo : les deux candidats ne sont essayés que sur une adresse, et
    // la forme adresse ne passe pas le format de pseudo.
    candidats: 1,
    appel: (m) => m.handleGameGrant(budget('POST', '/api/game/grant', { target: 'joueur', tokens: 50 }), env),
    econ: '/api/site/grant',
    succes: (u) => ({ statut: 200, corps: { ok: true, username: u, credits: 120, giftId: 'g1' } }),
    tous404: { statut: 404, corps: AUCUN_COMPTE },
    refus: { statut: 502, corps: refuse },
    panne: { statut: 502, corps: INJOIGNABLE }
  },
  {
    nom: 'plus — REC BLUE Plus par date',
    appel: (m) => m.handleGamePlus(budget('POST', '/api/game/plus', { target: 'joueur', until: '2026-12-31T00:00:00Z' }), env),
    econ: '/api/site/plus',
    succes: (u) => ({ statut: 200, corps: { ok: true, username: u, hasPlus: true, until: '2026-12-31T00:00:00Z' } }),
    tous404: { statut: 404, corps: AUCUN_COMPTE },
    refus: { statut: 502, corps: refuse },
    panne: { statut: 502, corps: INJOIGNABLE }
  },
  {
    nom: 'credits — solde du joueur (lecture)',
    appel: (m) => m.handleGameCredits(budget('GET', '/api/game/credits'), env),
    econ: '/api/site/balance?username=joueur',
    // `accountId` n'est renseigné que si le jeu le renvoie : ici il ne le fait pas.
    succes: (u) => ({ statut: 200, corps: { credits: 120, username: u, accountId: null } }),
    // Une lecture ne s'arrete pas sur un refus : elle essaie le candidat suivant.
    tous404: { statut: 200, corps: { credits: null, username: 'joueur' } },
    refus: { statut: 200, corps: { credits: null, username: 'joueur' }, plan: [json(500, {}), json(500, {})] },
    panne: { statut: 200, corps: { credits: null, username: null } }
  },
  {
    nom: 'role — rôle d’équipe (et fiche du site)',
    appel: (m) => m.handleGameRole(budget('POST', '/api/game/role', { target: 'joueur', role: 'moderator' }), env),
    econ: '/api/site/role',
    succes: (u) => ({
      statut: 200,
      corps: { ok: true, username: u, role: 'moderator', isModerator: true, isDeveloper: false, site: site(u) }
    }),
    tous404: { statut: 404, corps: AUCUN_COMPTE },
    refus: { statut: 502, corps: refuse },
    panne: { statut: 502, corps: INJOIGNABLE }
  },
  {
    nom: 'certify — certification',
    appel: (m) => m.handleGameCertify(budget('POST', '/api/game/certify', { target: 'joueur', certified: true }), env),
    econ: '/api/site/certify',
    succes: (u) => ({ statut: 200, corps: { ok: true, username: u, certified: true } }),
    tous404: { statut: 404, corps: AUCUN_COMPTE },
    refus: { statut: 502, corps: refuse },
    panne: { statut: 502, corps: INJOIGNABLE }
  },
  {
    nom: 'developer — badge développeur',
    appel: (m) => m.handleGameDeveloper(budget('POST', '/api/game/developer', { target: 'joueur', developer: true }), env),
    econ: '/api/site/developer',
    succes: (u) => ({ statut: 200, corps: { ok: true, username: u, developer: true } }),
    tous404: { statut: 404, corps: AUCUN_COMPTE },
    refus: { statut: 502, corps: refuse },
    panne: { statut: 502, corps: INJOIGNABLE }
  },
  {
    nom: 'avatar — photo de profil (lecture)',
    appel: (m) => m.handleGameAvatar(budget('GET', '/api/game/avatar'), env),
    econ: '/api/site/profile-image?username=joueur',
    succes: (u) => ({ statut: 200, corps: { username: u, image: 'https://img.example/p/1.png', banner: null } }),
    tous404: { statut: 200, corps: { image: null, banner: null } },
    refus: { statut: 200, corps: { image: null, banner: null }, plan: [json(500, {}), json(500, {})] },
    panne: { statut: 502, corps: INJOIGNABLE }
  },
  {
    nom: 'site-plus — Plus posé sur la fiche du site',
    appel: (m) => m.handleGameSitePlus(budget('POST', '/api/game/site-plus', { target: 'joueur', until: '2026-12-31T00:00:00Z' }), env),
    econ: '/api/site/plus',
    succes: (u) => ({ statut: 200, corps: { ok: true, until: '2026-12-31T00:00:00Z', game: { ok: true, username: u } } }),
    tous404: () => ({ statut: 200, corps: { ok: true, until: '2026-12-31T00:00:00Z', game: { ok: false, error: 'Aucun compte de jeu trouvé.' } } }),
    refus: () => ({ statut: 200, corps: { ok: true, until: '2026-12-31T00:00:00Z', game: { ok: false, error: 'Le serveur de jeu a refusé (500).' } } }),
    panne: () => ({ statut: 200, corps: { ok: true, until: '2026-12-31T00:00:00Z', game: { ok: false, error: 'Le serveur de jeu est injoignable.' } } })
  },
  {
    nom: 'ban — bannir',
    appel: (m) => m.handleGameBan(budget('POST', '/api/game/ban', { target: 'joueur', ban: true }), env),
    econ: '/api/site/ban',
    succes: (u) => ({ statut: 200, corps: { ok: true, username: u, banned: true, reason: '', until: null } }),
    tous404: { statut: 404, corps: AUCUN_COMPTE },
    refus: { statut: 502, corps: refuse },
    panne: { statut: 502, corps: INJOIGNABLE }
  },
  {
    nom: 'debit — retirer des crédits',
    appel: (m) => m.handleGameDebit(budget('POST', '/api/game/debit', { target: 'joueur', tokens: 10 }), env),
    econ: '/api/site/debit',
    succes: (u) => ({ statut: 200, corps: { ok: true, username: u, credits: 120, removed: 5 } }),
    tous404: { statut: 404, corps: AUCUN_COMPTE },
    refus: { statut: 502, corps: refuse },
    panne: { statut: 502, corps: INJOIGNABLE }
  },
  {
    nom: 'gift — donner un objet',
    appel: (m) => m.handleGameGiftItem(budget('POST', '/api/game/gift-item', { target: 'joueur', storefront: 3, item: 7, quantity: 1 }), env),
    econ: '/api/site/gift-item',
    succes: (u) => ({ statut: 200, corps: { ok: true, username: u, item: { id: 7, name: 'Chapeau' }, quantity: 1, stacks: false, giftId: 'g1' } }),
    tous404: { statut: 404, corps: AUCUN_COMPTE },
    refus: { statut: 502, corps: refuse },
    panne: { statut: 502, corps: INJOIGNABLE }
  },
  {
    nom: 'site-role — rôle poussé par la fiche du site',
    // Passe par `pushGameRole` : cible résolue par pseudo ET par nom affiché.
    appel: (m) =>
      m.handleGameSiteRole(
        budget('POST', '/api/game/site-role', {
          id: '11111111-1111-1111-1111-111111111111',
          role: 'moderator',
          target: 'joueur'
        }),
        env
      ),
    econ: '/api/site/role',
    succes: (u) => ({
      statut: 200,
      corps: {
        ok: true,
        role: 'moderator',
        site: { ok: true, role: 'moderator' },
        game: { ok: true, username: u, isModerator: true, isDeveloper: false }
      }
    }),
    tous404: () => ({
      statut: 200,
      corps: {
        ok: true,
        role: 'moderator',
        site: { ok: true, role: 'moderator' },
        game: { ok: false, error: 'Aucun compte de jeu ne correspond à « joueur ».' }
      }
    }),
    refus: () => ({
      statut: 200,
      corps: {
        ok: true,
        role: 'moderator',
        site: { ok: true, role: 'moderator' },
        game: { ok: false, error: 'Le serveur de jeu a refusé (500).' }
      }
    }),
    panne: () => ({
      statut: 200,
      corps: {
        ok: true,
        role: 'moderator',
        site: { ok: true, role: 'moderator' },
        game: { ok: false, error: 'Le serveur de jeu est injoignable.' }
      }
    })
  },
  {
    nom: 'syncGamePlus — Plus relu depuis la fiche, puis poussé',
    appel: (m) => m.syncGamePlus(env, 'user-1', 'second'),
    econ: '/api/site/plus',
    succes: (u) => ({
      statut: 200,
      corps: { ok: true, until: '2026-12-31T00:00:00.000Z', game: { ok: true, username: u } }
    }),
    // Un compte de jeu introuvable n'invalide pas l'achat : la date reste enregistrée.
    tous404: {
      statut: 200,
      corps: { ok: true, until: '2026-12-31T00:00:00.000Z', game: { ok: false, reason: 'no pseudo' } }
    },
    refus: {
      statut: 200,
      corps: { ok: true, until: '2026-12-31T00:00:00.000Z', game: { ok: false, reason: 'status 500' } }
    },
    panne: {
      statut: 200,
      corps: { ok: true, until: '2026-12-31T00:00:00.000Z', game: { ok: false, reason: 'unreachable' } }
    }
  },
  {
    nom: 'grantGameCredits — crédit après achat',
    // Pseudo d'achat différent du nom affiché : le pont essaie les deux.
    appel: (m) => m.grantGameCredits(env, 'user-1', 50, 'commande-1', 'second', 'merci'),
    econ: '/api/site/grant',
    succes: (u) => ({ statut: 200, corps: { ok: true, username: u, giftId: 'g1', balance: 120 } }),
    tous404: { statut: 200, corps: { ok: false, reason: 'status 404' } },
    refus: { statut: 200, corps: { ok: false, reason: 'status 500' } },
    panne: { statut: 200, corps: { ok: false, reason: 'unreachable' } }
  }
];

async function executer(cas, plan) {
  const appels = serveurSimule(plan);
  const reponse = await cas.appel(pont);
  if (!(reponse instanceof Response)) return { statut: 200, corps: reponse, appels };
  const texte = await reponse.text();
  let corps = null;
  try { corps = JSON.parse(texte); } catch { corps = texte; }
  return { statut: reponse.status, corps, appels };
}

const attenduDe = (valeur, u) => (typeof valeur === 'function' ? valeur(u) : valeur);

for (const cas of CAS) {
  const nombreCandidats = cas.candidats || 2;

  test(cas.nom, async (t) => {
    await t.test('succès : le premier candidat suffit', async () => {
      const r = await executer(cas, PLANS.succes());
      const attendu = attenduDe(cas.succes, 'joueur');
      assert.equal(r.statut, attendu.statut);
      assert.deepEqual(r.corps, attendu.corps);
      assert.equal(r.appels.length, 1, 'un seul appel au serveur de jeu');
      assert.ok(r.appels[0].startsWith(cas.econ), 'route appelée : ' + r.appels[0]);
    });

    await t.test('404 puis candidat suivant', async () => {
      const plan = nombreCandidats === 1 ? [json(404, {})] : PLANS.suivant();
      const r = await executer(cas, plan);
      const attendu = attenduDe(cas.succes, nombreCandidats === 1 ? 'joueur' : 'second');
      if (nombreCandidats === 1) {
        // Cette route ne garde qu'un candidat : un 404 est un échec, pas un passage.
        const echec = attenduDe(cas.tous404, 'joueur');
        assert.equal(r.statut, echec.statut);
        assert.deepEqual(r.corps, echec.corps);
        assert.equal(r.appels.length, 1, 'aucun second candidat pour un pseudo');
      } else {
        assert.equal(r.statut, attendu.statut);
        assert.deepEqual(r.corps, attendu.corps, 'le succès porte le nom du second candidat');
        assert.equal(r.appels.length, 2, 'deux candidats essayés');
      }
    });

    await t.test('tous les candidats en 404', async () => {
      const r = await executer(cas, PLANS.tous404());
      const attendu = attenduDe(cas.tous404, 'joueur');
      assert.equal(r.statut, attendu.statut);
      assert.deepEqual(r.corps, attendu.corps);
      assert.equal(r.appels.length, nombreCandidats, 'tous les candidats ont été essayés');
    });

    await t.test('refus du serveur de jeu (500)', async () => {
      const plan = cas.refus.plan || PLANS.refus();
      const prevus = plan.length;
      const r = await executer(cas, plan);
      const attendu = attenduDe(cas.refus, 'joueur');
      assert.equal(r.statut, attendu.statut);
      assert.deepEqual(r.corps, attendu.corps);
      assert.equal(r.appels.length, prevus, 'on n’essaie pas un autre pseudo après un refus');
    });

    await t.test('panne réseau', async () => {
      const r = await executer(cas, PLANS.panne());
      const attendu = attenduDe(cas.panne, 'joueur');
      assert.equal(r.statut, attendu.statut);
      assert.deepEqual(r.corps, attendu.corps);
      assert.equal(r.appels.length, 1, 'on n’insiste pas sur un autre pseudo');
    });
  });
}
