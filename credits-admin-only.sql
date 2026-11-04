-- Ajout de crédits réservé aux administrateurs.
-- Les modérateurs consultent la liste des comptes mais n'attribuent plus rien.
create or replace function public.recblue_grant_credits(p_identifier text, p_amount integer)
returns integer
language plpgsql security definer set search_path = '' as $$
declare
  target_id uuid;
  new_balance integer;
  needle text;
  matches integer;
begin
  if auth.uid() is null or not private.recblue_is_admin() then
    raise exception 'Accès administrateur requis' using errcode = '42501';
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
end;
$$;

revoke all on function public.recblue_grant_credits(text, integer) from public, anon, authenticated;
grant execute on function public.recblue_grant_credits(text, integer) to authenticated;
