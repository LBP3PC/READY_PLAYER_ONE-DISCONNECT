# Comptes REC BLUE

## Droits

- Visiteur : contenu public, aucune donnée de compte.
- Membre : consulter son profil, modifier son propre pseudo.
- Administrateur : consulter les 100 comptes les plus récents et attribuer les rôles membre/administrateur.
- Aucun droit sur le jeu, les achats ou les publications n'est ajouté implicitement.

Les droits sont vérifiés par PostgreSQL (RLS et fonctions SQL), pas par le navigateur. Aucun rôle ne provient de métadonnées utilisateur. Aucun INSERT/DELETE de profil ni UPDATE du rôle n'est accordé au navigateur. Le dernier administrateur ne peut pas être rétrogradé par l'API.

## Configuration à effectuer

1. Créer un projet Supabase : https://supabase.com/dashboard .
2. Exécuter `accounts.sql` une seule fois dans son SQL Editor (ne pas réexécuter sur un schéma déjà installé). Ne pas exposer le schéma `private` dans la Data API.
3. Activer le fournisseur Email avec confirmation obligatoire. Régler le minimum du mot de passe à 12 caractères dans Authentication. Configurer Site URL et Redirect URLs avec l'origine exacte du site, ou l'aperçu à tester. Le service email inclus est limité ; configurer un SMTP approprié avant une ouverture publique importante.
4. Dans `account-config.js`, renseigner `supabaseUrl` avec l'URL publique du projet et `publishableKey` avec la clé **publique** `sb_publishable_...` (Settings > API Keys). Ce fichier est envoyé au navigateur : JAMAIS de clé secrète, service_role, mot de passe ou deploy key ici.
5. Créer et confirmer votre compte depuis le site. Pour la première session, confirmer l'email puis se connecter manuellement si nécessaire.
6. Copier son UUID depuis Authentication > Users, puis exécuter séparément dans SQL Editor :

```sql
update public.recblue_accounts
set role = 'admin'
where id = 'UUID_DE_VOTRE_COMPTE';
```

Vérifier soigneusement l'UUID avant de donner les droits. Le premier inscrit n'est jamais automatiquement administrateur. Les changements suivants se font depuis Mon compte > Administration des comptes. Les propriétaires du projet Supabase peuvent aussi gérer les comptes depuis le dashboard.

## Sessions et confidentialité

Le SDK est chargé via un CDN à version épinglée. Les jetons ne sont ni écrits dans les fichiers du projet ni conservés dans localStorage : session en mémoire, fin au rechargement de page. Les mots de passe sont envoyés uniquement à Supabase via HTTPS. Les préférences de langue et notifications restent indépendantes dans localStorage. Les noms utilisateurs sont insérés avec textContent, jamais comme HTML.

La politique de confidentialité officielle et les coordonnées de contact doivent être finalisées avant publication. Ce travail ne publie rien et ne connecte pas les comptes au moteur du jeu.

## Vérifications à faire une fois configuré

Les checks statiques locaux ne prouvent pas la sécurité de la base déployée. Avec deux vrais comptes distincts, vérifier :

- inscription et confirmation email, mauvais mot de passe, connexion puis déconnexion ;
- membre A ne lit/modifie pas le profil B et ne peut pas changer `role`, `id` ou `created_at` par une requête directe ;
- visiteur sans session n'accède pas à `recblue_accounts` ni à la RPC de rôles ;
- appel direct à `recblue_set_role` par un membre refusé ;
- administrateur peut promouvoir/rétrograder un membre ; ancien administrateur immédiatement refusé par la RPC ;
- rétrogradation du dernier administrateur refusée, y compris changements concurrents ;
- une inscription contenant des métadonnées `role: admin` produit toujours un membre ;
- fermeture/rechargement termine la session locale, données privées effacées après déconnexion.

## Documentation

- https://supabase.com/docs/guides/auth/passwords
- https://supabase.com/docs/guides/auth/redirect-urls
- https://supabase.com/docs/guides/database/postgres/row-level-security
- https://supabase.com/docs/guides/database/functions
