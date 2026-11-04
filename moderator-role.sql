-- Rôle de modération + correction de l'ajout de crédits.
-- À exécuter une fois dans le SQL Editor Supabase.
begin;

-- 1) Le rôle « moderator » devient une valeur acceptée par la table.
alter table public.recblue_accounts drop constraint if exists recblue_accounts_role_check;
alter table public.recblue_accounts
  add constraint recblue_accounts_role_check check (role in ('member', 'moderator', 'admin'));

-- 2) « Équipe » = administrateur ou modérateur.
create or replace function private.recblue_is_staff() returns boolean
language sql stable security definer set search_path = ''
as $$ select exists(select 1 from public.recblue_accounts where id = (select auth.uid()) and role in ('moderator', 'admin')); $$;
revoke all on function private.recblue_is_staff() from public, anon, authenticated;

-- 3) Ajout de crédits : ouvert à l'équipe, et recherche par nom affiché en plus
--    du pseudo et de l'email (l'ancienne version échouait avec « Compte introuvable »
--    quand le compte avait une vraie adresse email).
create or replace function public.recblue_grant_credits(p_identifier text, p_amount integer)
returns integer
language plpgsql security definer set search_path = '' as $$
declare
  target_id uuid;
  new_balance integer;
  needle text;
  matches integer;
begin
  if auth.uid() is null or not private.recblue_is_staff() then
    raise exception 'Accès réservé à l’équipe' using errcode = '42501';
  end if;
  if p_amount is null or p_amount = 0 or abs(p_amount) > 1000000 then
    raise exception 'Montant invalide';
  end if;
  needle := ltrim(lower(trim(coalesce(p_identifier, ''))), '@');
  if needle = '' then
    raise exception 'Compte introuvable';
  end if;

  select count(*) into matches
  from public.recblue_accounts a
  join auth.users u on u.id = a.id
  where lower(u.email) = needle
     or lower(u.email) = needle || '@players.recblue.invalid'
     or lower(a.display_name) = needle;

  if matches = 0 then
    raise exception 'Compte introuvable';
  end if;
  if matches > 1 then
    raise exception 'Plusieurs comptes correspondent : indiquez l’adresse email exacte';
  end if;

  select a.id into target_id
  from public.recblue_accounts a
  join auth.users u on u.id = a.id
  where lower(u.email) = needle
     or lower(u.email) = needle || '@players.recblue.invalid'
     or lower(a.display_name) = needle
  limit 1;

  update public.recblue_accounts set credits = greatest(0, credits + p_amount)
  where id = target_id
  returning credits into new_balance;

  if new_balance is null then
    raise exception 'Profil introuvable';
  end if;
  return new_balance;
end; $$;
revoke all on function public.recblue_grant_credits(text, integer) from public, anon, authenticated;
grant execute on function public.recblue_grant_credits(text, integer) to authenticated;

-- 4) Changement de rôle : administrateurs seulement, valeurs contrôlées.
--    Le dernier administrateur reste protégé, y compris face à une rétrogradation
--    vers « modérateur ».
create or replace function private.recblue_set_role(target_id uuid, new_role text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or not private.recblue_is_admin() then
    raise exception 'Accès administrateur requis' using errcode = '42501';
  end if;
  if new_role is null or new_role not in ('member', 'moderator', 'admin') then
    raise exception 'Rôle inconnu';
  end if;
  lock table public.recblue_accounts in share row exclusive mode;
  if auth.uid() is null or not private.recblue_is_admin() then
    raise exception 'Accès administrateur requis' using errcode = '42501';
  end if;
  if not exists(select 1 from public.recblue_accounts where id = target_id) then
    raise exception 'Compte introuvable';
  end if;
  if new_role <> 'admin'
     and exists(select 1 from public.recblue_accounts where id = target_id and role = 'admin')
     and (select count(*) from public.recblue_accounts where role = 'admin') <= 1 then
    raise exception 'Impossible de retirer le dernier administrateur';
  end if;
  update public.recblue_accounts set role = new_role where id = target_id;
end; $$;
revoke all on function private.recblue_set_role(uuid, text) from public, anon, authenticated;
grant execute on function private.recblue_set_role(uuid, text) to authenticated;

commit;
