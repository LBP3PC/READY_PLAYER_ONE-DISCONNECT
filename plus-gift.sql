-- 1) Attribuer ou retirer REC BLUE Plus avec une date de fin.
--    Réservé aux administrateurs : accorder un avantage payant est un droit
--    plus sensible que l'ajout de crédits.
--    p_until = null retire le Plus ; une date passée est refusée.
create or replace function public.recblue_grant_plus(p_identifier text, p_until timestamptz)
returns timestamptz
language plpgsql security definer set search_path = '' as $$
declare
  target_id uuid;
  needle text;
  matches integer;
begin
  if auth.uid() is null or not private.recblue_is_admin() then
    raise exception 'Accès administrateur requis' using errcode = '42501';
  end if;

  needle := ltrim(lower(trim(coalesce(p_identifier, ''))), '@');
  if needle = '' then
    raise exception 'Compte introuvable';
  end if;

  if p_until is not null and p_until <= now() then
    raise exception 'Choisissez une date de fin dans le futur';
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

  update public.recblue_accounts set plus_until = p_until where id = target_id;

  if not found then
    raise exception 'Profil introuvable';
  end if;

  return p_until;
end;
$$;

revoke all on function public.recblue_grant_plus(text, timestamptz) from public, anon, authenticated;
grant execute on function public.recblue_grant_plus(text, timestamptz) to authenticated;

-- Vérification rapide : le plus tardif des membres actuels doit être nul.
-- select display_name, plus_until from public.recblue_accounts order by plus_until desc nulls last limit 5;
