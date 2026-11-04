-- Exécuter une fois dans le SQL Editor du projet Supabase, avant toute inscription.
begin;
create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated;

create table public.recblue_accounts (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default 'Joueur' check (char_length(display_name) between 2 and 40),
  role text not null default 'member' check (role in ('member', 'moderator', 'admin')),
  created_at timestamptz not null default now()
);
alter table public.recblue_accounts enable row level security;
revoke all on public.recblue_accounts from public, anon, authenticated;
grant select on public.recblue_accounts to authenticated;
grant update (display_name) on public.recblue_accounts to authenticated;

create function private.recblue_is_admin() returns boolean
language sql stable security definer set search_path = ''
as $$ select exists(select 1 from public.recblue_accounts where id = (select auth.uid()) and role = 'admin'); $$;
revoke all on function private.recblue_is_admin() from public, anon, authenticated;
grant execute on function private.recblue_is_admin() to authenticated;

create policy account_read on public.recblue_accounts for select to authenticated
using (id = (select auth.uid()) or (select private.recblue_is_admin()));
create policy account_edit_name on public.recblue_accounts for update to authenticated
using (id = (select auth.uid())) with check (id = (select auth.uid()));

create function private.recblue_new_account() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  -- Le rôle ne provient JAMAIS des métadonnées envoyées par l'utilisateur.
  insert into public.recblue_accounts(id) values (new.id);
  return new;
end; $$;
revoke all on function private.recblue_new_account() from public, anon, authenticated;
create trigger recblue_account_created after insert on auth.users
for each row execute function private.recblue_new_account();
insert into public.recblue_accounts(id) select id from auth.users on conflict (id) do nothing;

create function private.recblue_set_role(target_id uuid, new_role text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  -- Rejeter les non-administrateurs AVANT de verrouiller la table, afin qu'un
  -- membre ne puisse pas bloquer les opérations sur les comptes par cette RPC.
  if auth.uid() is null or not private.recblue_is_admin() then
    raise exception 'Accès administrateur requis' using errcode = '42501';
  end if;
  -- Sérialiser les modifications puis revérifier le rôle : il a pu changer
  -- pendant l'attente du verrou. Protège aussi le dernier administrateur.
  lock table public.recblue_accounts in share row exclusive mode;
  if not private.recblue_is_admin() then
    raise exception 'Accès administrateur requis' using errcode = '42501';
  end if;
  if new_role is null or new_role not in ('member', 'admin') then
    raise exception 'Rôle invalide';
  end if;
  if not exists(select 1 from public.recblue_accounts where id = target_id) then
    raise exception 'Compte introuvable';
  end if;
  if new_role = 'member'
     and exists(select 1 from public.recblue_accounts where id = target_id and role = 'admin')
     and (select count(*) from public.recblue_accounts where role = 'admin') <= 1 then
    raise exception 'Impossible de retirer le dernier administrateur';
  end if;
  update public.recblue_accounts set role = new_role where id = target_id;
end; $$;
revoke all on function private.recblue_set_role(uuid, text) from public, anon, authenticated;
grant execute on function private.recblue_set_role(uuid, text) to authenticated;

-- Point d'entrée API sans privilège propre ; les contrôles restent privés.
create function public.recblue_set_role(target_id uuid, new_role text) returns void
language sql security invoker set search_path = ''
as $$ select private.recblue_set_role(target_id, new_role); $$;
revoke all on function public.recblue_set_role(uuid, text) from public, anon, authenticated;
grant execute on function public.recblue_set_role(uuid, text) to authenticated;
commit;

-- PREMIER ADMIN : après création et confirmation de votre propre compte,
-- exécuter séparément, depuis le SQL Editor uniquement, avec votre UUID :
-- update public.recblue_accounts set role = 'admin' where id = 'UUID_DE_VOTRE_COMPTE';
