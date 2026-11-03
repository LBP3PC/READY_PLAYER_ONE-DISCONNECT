-- Achats de crédits par PayPal. À exécuter une fois dans le SQL Editor Supabase.
-- Le site ne peut jamais écrire les crédits : seule la fonction serveur Vercel,
-- avec la clé de service, appelle recblue_credit_purchase.
begin;
create table if not exists public.recblue_purchases (
  order_id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  pack text not null,
  credits integer not null check (credits > 0),
  amount_cents integer not null check (amount_cents > 0),
  currency text not null default 'USD',
  created_at timestamptz not null default now()
);
alter table public.recblue_purchases enable row level security;
revoke all on public.recblue_purchases from public, anon, authenticated;
grant select on public.recblue_purchases to authenticated;

drop policy if exists purchase_read_own on public.recblue_purchases;
create policy purchase_read_own on public.recblue_purchases for select to authenticated
using (user_id = (select auth.uid()));

-- Idempotente : une même commande PayPal ne crédite qu'une seule fois.
create or replace function public.recblue_credit_purchase(
  p_order_id text,
  p_user uuid,
  p_pack text,
  p_credits integer,
  p_amount_cents integer,
  p_currency text default 'USD'
) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  new_balance integer;
begin
  if p_order_id is null or char_length(p_order_id) < 8 then
    raise exception 'Commande invalide';
  end if;
  if p_credits is null or p_credits <= 0 or p_credits > 100000 then
    raise exception 'Crédits invalides';
  end if;
  if p_amount_cents is null or p_amount_cents <= 0 then
    raise exception 'Montant invalide';
  end if;
  if not exists (select 1 from public.recblue_accounts where id = p_user) then
    raise exception 'Compte introuvable';
  end if;
  insert into public.recblue_purchases(order_id, user_id, pack, credits, amount_cents, currency)
  values (p_order_id, p_user, coalesce(p_pack, 'pack'), p_credits, p_amount_cents, upper(coalesce(p_currency, 'USD')))
  on conflict (order_id) do nothing;
  if not found then
    -- Commande déjà créditée : on renvoie le solde sans rien ajouter.
    select credits into new_balance from public.recblue_accounts where id = p_user;
    return new_balance;
  end if;
  update public.recblue_accounts set credits = credits + p_credits
  where id = p_user
  returning credits into new_balance;
  return new_balance;
end; $$;
revoke all on function public.recblue_credit_purchase(text, uuid, text, integer, integer, text) from public, anon, authenticated;
grant execute on function public.recblue_credit_purchase(text, uuid, text, integer, integer, text) to service_role;
commit;
