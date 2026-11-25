# Coffres REC BLUE

Sauvegardes du code du serveur, du client patché et du lanceur.

## Fichiers

| Fichier | Taille | Contenu |
|---|---|---|
| `coffre-recblue-20261125.zip` | ~216 Mo | **Tout** : code, binaires distribués, images, pack 2025. Reste sur le poste (dépasse la limite GitHub de 100 Mo par fichier). |
| `coffre-recblue-code-20261125.zip` | ~10 Mo | **Code seul** : sources des Workers, plugin, lanceur, site. C'est celui qui est versionné ici. |

## Ce que les coffres ne contiennent jamais

Aucun secret : ni `.env`, ni clé Supabase, ni jeton Cloudflare. Les clés se remettent
après restauration, via les procédures du dépôt.

## Contenu du coffre de code

- `recflare-serveur/` — les Workers du serveur (apps, packages partagés, migrations)
- `game-plugin/` — le plugin du client 2023
- `launcher-app/` — le lanceur (source + `build.cmd`)
- `hosting/` — le site, le pont de jeu, la boutique
- `recblue-stub/` — le Worker qui répond pour les 8 services non implémentés

## Restauration

1. Dézipper dans un dossier de travail.
2. `npm install` (ou `bun install`) dans `recflare-serveur/` pour retrouver les dépendances.
3. Recréer les secrets : `SUPABASE_SECRET_KEY`, `SUPABASE_URL`, `JWT_SECRET`,
   `SITE_BRIDGE_TOKEN`, et les `PHOTON_*`.
4. Redéployer les Workers nécessaires avec `wrangler deploy` depuis chaque app.
5. Recompiler le lanceur : `launcher-app\build.cmd`.

## Vérification

```bash
tar -tf coffres/coffre-recblue-code-20261125.zip | wc -l
```
