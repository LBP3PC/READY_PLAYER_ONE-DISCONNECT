-- Ajout manuel de crédits, réservé aux administrateurs.
-- Le contrôle du rôle est fait dans la fonction : un membre ne peut pas l'appeler.
begin;
create or replace function public.recblue_grant_credits(p_identifier text, p_amount integer)
returns integer
language plpgsql security definer set search_path = '' as $$
declare
  target_id uuid;
  new_balance integer;
  needle text;
begin
  if auth.uid() is null or not private.recblue_is_admin() then
    raise exception 'Accès administrateur requis' using errcode = '42501';
  end if;
  if p_amount is null or p_amount = 0 or abs(p_amount) > 1000000 then
    raise exception 'Montant invalide';
  end if;
  needle := lower(trim(coalesce(p_identifier, '')));
  if needle = '' then
    raise exception 'Compte introuvable';
  end if;
  -- Accepte un pseudo (converti en adresse technique) ou une adresse email.
  select id into target_id from auth.users
  where lower(email) = needle or lower(email) = needle || '@players.recblue.invalid'
  limit 1;
  if target_id is null then
    raise exception 'Compte introuvable';
  end if;
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
commit;
