-- Le niveau affiché d'un membre sur le site.
--
-- Il vit à côté de la progression du JEU, pas dedans : `recblue_accounts.level` ne sert
-- qu'à l'affichage sur le site, un chiffre choisi à la main n'a pas à modifier les niveaux
-- gagnés en jouant ni la barre d'XP du client. Le niveau de jeu reste lu depuis `econ`.
--
-- À appliquer une fois dans Supabase (SQL Editor) avant de déployer le Worker : sans la
-- colonne, l'enregistrement répond 503 « La colonne « level » manque en base ».

alter table public.recblue_accounts
  add column if not exists level integer not null default 1;

-- 0 à 999 : de quoi distinguer les membres sans transformer le champ en dépotoir.
alter table public.recblue_accounts
  drop constraint if exists recblue_accounts_level_range;

alter table public.recblue_accounts
  add constraint recblue_accounts_level_range check (level >= 0 and level <= 999);
