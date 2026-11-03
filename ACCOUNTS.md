# Comptes REC BLUE

## Connexion par pseudo

Les nouveaux comptes utilisent un **pseudo et un mot de passe** : aucune adresse email n’est demandée.

- Supabase Auth n’accepte que des identifiants de type email ou téléphone. Le navigateur construit donc une adresse technique réservée `PSEUDO@players.recblue.invalid` (domaine `.invalid`, jamais délivrable) et c’est elle qui sert d’identifiant. Le pseudo est unique par construction, en minuscules, 3 à 20 caractères (`a-z`, `0-9`, `_`, `-`).
- Les comptes créés auparavant avec une adresse email continuent de se connecter avec leur email : le champ d’identification accepte un pseudo ou une adresse contenant `@`.
- Le champ « Mon pseudo » du profil est le nom affiché (2 à 40 caractères). Il peut différer du pseudo de connexion, qui lui reste fixe.
- Conséquence à connaître : **sans email, aucun mot de passe oublié ne peut être récupéré par le membre**. Un administrateur doit alors réinitialiser le mot de passe depuis le dashboard Supabase (Authentication > Users).

## Droits

- Visiteur : contenu public, aucune donnée de compte.
- Membre : consulter son profil, modifier son propre pseudo.
- Administrateur : consulter les 100 comptes les plus récents et attribuer les rôles membre/administrateur.
- Aucun droit sur le jeu, les achats ou les publications n'est ajouté implicitement.

Les droits sont vérifiés par PostgreSQL (RLS et fonctions SQL), pas par le navigateur. Aucun rôle ne provient de métadonnées utilisateur. Aucun INSERT/DELETE de profil ni UPDATE du rôle n'est accordé au navigateur. Le dernier administrateur ne peut pas être rétrogradé par l'API.

## Configuration à effectuer

1. Créer un projet Supabase : https://supabase.com/dashboard .
2. Exécuter `accounts.sql` une seule fois dans son SQL Editor (ne pas réexécuter sur un schéma déjà installé). Ne pas exposer le schéma `private` dans la Data API.
3. Dans Authentication, garder le fournisseur Email actif mais **désactiver « Confirm email »** (Authentication > Sign In / Providers > Email) : c'est obligatoire pour que les comptes par pseudo fonctionnent sans boîte mail. Conséquence : Supabase ne vérifie plus aucune adresse email à l'inscription. Le site ne se sert donc jamais de l'email comme preuve d'identité et n'envoie aucun message à ces adresses. Régler aussi le minimum du mot de passe à 12 caractères. Configurer Site URL et Redirect URLs avec l'origine exacte du site, ou l'aperçu à tester.
4. Dans `account-config.js`, renseigner `supabaseUrl` avec l'URL HTTPS standard `https://PROJET.supabase.co` et `publishableKey` avec la clé **publique** `sb_publishable_...` (Settings > API Keys). Ce fichier est envoyé au navigateur : JAMAIS de clé secrète, service_role, mot de passe ou deploy key ici. Les domaines Supabase personnalisés ne sont pas acceptés par cette configuration de sécurité.
5. Créer votre compte depuis le site avec un pseudo et un mot de passe.
6. Copier son UUID depuis Authentication > Users, puis exécuter séparément dans SQL Editor :

```sql
update public.recblue_accounts
set role = 'admin'
where id = 'UUID_DE_VOTRE_COMPTE';
```

Vérifier soigneusement l'UUID avant de donner les droits. Le premier inscrit n'est jamais automatiquement administrateur. Les changements suivants se font depuis Mon compte > Administration des comptes. Les propriétaires du projet Supabase peuvent aussi gérer les comptes depuis le dashboard.

## Sessions et confidentialité

Le SDK est chargé via un CDN à version épinglée et vérifié par une empreinte d'intégrité (SRI). Les en-têtes du site Vercel sont définis dans `hosting/public/vercel.json` ; tout changement du script intégré à `index.html` exige de recalculer son empreinte CSP avant publication. Le jeton de session est conservé dans le stockage local du navigateur afin de rester connecté après un rechargement ; il est supprimé à la déconnexion. Ce choix facilite l'usage mais expose le jeton à une faille XSS : la CSP et l'absence de HTML injecté restent donc indispensables. Les mots de passe sont envoyés uniquement à Supabase via HTTPS. Les préférences de langue et notifications restent indépendantes dans localStorage. Les noms utilisateurs sont insérés avec textContent, jamais comme HTML.

La politique de confidentialité officielle et les coordonnées de contact doivent être finalisées avant publication. Ce travail ne connecte pas les comptes au moteur du jeu.

Aucun anti-robots (CAPTCHA) ne protège encore l’inscription publique : un script peut créer des comptes en série. Ajouter Turnstile ou équivalent avant une ouverture large.

## Vérifications à faire une fois configuré

Les checks statiques locaux ne prouvent pas la sécurité de la base déployée. Avec deux vrais comptes distincts, vérifier :

- inscription par pseudo, pseudo déjà pris, mauvais mot de passe, connexion puis déconnexion ;
- connexion d’un ancien compte avec son adresse email ;
- pseudo invalide (moins de 3 caractères, espace, `@`, majuscules mélangées) refusé ;
- membre A ne lit/modifie pas le profil B et ne peut pas changer `role`, `id` ou `created_at` par une requête directe ;
- visiteur sans session n'accède pas à `recblue_accounts` ni à la RPC de rôles ;
- appel direct à `recblue_set_role` par un membre refusé ;
- administrateur peut promouvoir/rétrograder un membre ; ancien administrateur immédiatement refusé par la RPC ;
- rétrogradation du dernier administrateur refusée, y compris changements concurrents ;
- une inscription contenant des métadonnées `role: admin` produit toujours un membre ;
- un rechargement de page garde la session ouverte ; « Se déconnecter » l'efface et efface les données privées.

## Documentation

- https://supabase.com/docs/guides/auth/passwords
- https://supabase.com/docs/guides/auth/redirect-urls
- https://supabase.com/docs/guides/database/postgres/row-level-security
- https://supabase.com/docs/guides/database/functions
