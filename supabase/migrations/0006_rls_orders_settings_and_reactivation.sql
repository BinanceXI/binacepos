-- BinanceXI POS (by Binance Labs)
-- RLS for remaining tenant tables + reactivation code RPCs.

begin;

/* -------------------------------------------------------------------------- */
/* Reactivation Code RPCs                                                     */
/* -------------------------------------------------------------------------- */

-- Platform admin: issue a code (returns plaintext once; only hash is stored).
create or replace function public.issue_reactivation_code(
  p_business_id uuid,
  p_months integer default 1
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_months integer := greatest(1, least(coalesce(p_months, 1), 24));
  v_code text;
  v_hash text;
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  if not public.is_platform_admin(v_uid) then
    raise exception 'Not authorized';
  end if;

  if p_business_id is null then
    raise exception 'Missing business_id';
  end if;

  -- 16 hex chars is short enough to type and long enough to avoid guessing.
  v_code := upper(substr(encode(gen_random_bytes(8), 'hex'), 1, 16));
  v_hash := encode(digest(v_code, 'sha256'), 'hex');

  insert into public.reactivation_codes (
    business_id,
    code_hash,
    code_prefix,
    months,
    issued_by,
    issued_at,
    active
  ) values (
    p_business_id,
    v_hash,
    substr(v_code, 1, 4),
    v_months,
    v_uid,
    now(),
    true
  );

  return v_code;
end;
$$;

revoke all on function public.issue_reactivation_code(uuid, integer) from public;
grant execute on function public.issue_reactivation_code(uuid, integer) to authenticated;

-- Tenant user: redeem a code for their own business (works even when locked).
create or replace function public.redeem_reactivation_code(p_code text)
returns public.business_billing
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_business_id uuid;
  v_code text := upper(trim(coalesce(p_code, '')));
  v_hash text;
  v_code_row public.reactivation_codes%rowtype;
  v_billing public.business_billing%rowtype;
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  v_business_id := public.current_business_id(v_uid);
  if v_business_id is null then
    raise exception 'Missing business context';
  end if;

  if v_code = '' then
    raise exception 'Code required';
  end if;

  v_hash := encode(digest(v_code, 'sha256'), 'hex');

  select *
    into v_code_row
  from public.reactivation_codes rc
  where rc.business_id = v_business_id
    and rc.active = true
    and rc.redeemed_at is null
    and rc.code_hash = v_hash
  limit 1;

  if not found then
    raise exception 'Invalid code';
  end if;

  update public.reactivation_codes
    set redeemed_by = v_uid,
        redeemed_at = now()
    where id = v_code_row.id
      and redeemed_at is null;

  update public.business_billing bb
    set paid_through = greatest(now(), bb.paid_through) + make_interval(days => 30 * greatest(1, v_code_row.months)),
        locked_override = false,
        updated_at = now()
    where bb.business_id = v_business_id
    returning * into v_billing;

  if not found then
    raise exception 'Billing record missing';
  end if;

  return v_billing;
end;
$$;

revoke all on function public.redeem_reactivation_code(text) from public;
grant execute on function public.redeem_reactivation_code(text) to authenticated;

/* -------------------------------------------------------------------------- */
/* RLS: orders + order_items                                                  */
/* -------------------------------------------------------------------------- */

alter table if exists public.orders enable row level security;
alter table if exists public.order_items enable row level security;

drop policy if exists orders_access on public.orders;
create policy orders_access
on public.orders
for all
to authenticated
using (
  public.is_platform_admin()
  or (
    business_id = public.current_business_id()
    and public.is_business_in_good_standing(business_id)
  )
)
with check (
  public.is_platform_admin()
  or (
    business_id = public.current_business_id()
    and public.is_business_in_good_standing(business_id)
  )
);

drop policy if exists order_items_access on public.order_items;
create policy order_items_access
on public.order_items
for all
to authenticated
using (
  public.is_platform_admin()
  or (
    business_id = public.current_business_id()
    and public.is_business_in_good_standing(business_id)
  )
)
with check (
  public.is_platform_admin()
  or (
    business_id = public.current_business_id()
    and public.is_business_in_good_standing(business_id)
  )
);

/* -------------------------------------------------------------------------- */
/* RLS: store_settings                                                        */
/* -------------------------------------------------------------------------- */

alter table if exists public.store_settings enable row level security;

drop policy if exists store_settings_read on public.store_settings;
create policy store_settings_read
on public.store_settings
for select
to authenticated
using (
  public.is_platform_admin()
  or (
    business_id = public.current_business_id()
    and public.is_business_in_good_standing(business_id)
  )
);

drop policy if exists store_settings_write on public.store_settings;
create policy store_settings_write
on public.store_settings
for all
to authenticated
using (
  public.is_platform_admin()
  or (
    business_id = public.current_business_id()
    and public.is_business_in_good_standing(business_id)
    and public.is_business_admin_user()
  )
)
with check (
  public.is_platform_admin()
  or (
    business_id = public.current_business_id()
    and public.is_business_in_good_standing(business_id)
    and public.is_business_admin_user()
  )
);

/* -------------------------------------------------------------------------- */
/* RLS: service_bookings                                                      */
/* -------------------------------------------------------------------------- */

alter table if exists public.service_bookings enable row level security;

drop policy if exists service_bookings_access on public.service_bookings;
create policy service_bookings_access
on public.service_bookings
for all
to authenticated
using (
  public.is_platform_admin()
  or (
    business_id = public.current_business_id()
    and public.is_business_in_good_standing(business_id)
  )
)
with check (
  public.is_platform_admin()
  or (
    business_id = public.current_business_id()
    and public.is_business_in_good_standing(business_id)
  )
);

commit;

