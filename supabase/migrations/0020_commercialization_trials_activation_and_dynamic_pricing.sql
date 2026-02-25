-- BinanceXI POS
-- Commercialization phase: dynamic pricing plans, trial/license tracking, activation requests,
-- platform billing settings (EcoCash), and admin RPCs for manual activation workflows.

begin;

/* -------------------------------------------------------------------------- */
/* pricing_plans: evolve to generic/dynamic plans (keep legacy columns)        */
/* -------------------------------------------------------------------------- */

do $$
begin
  if exists (
    select 1 from pg_constraint
    where conname = 'pricing_plans_plan_type_check'
      and conrelid = 'public.pricing_plans'::regclass
  ) then
    alter table public.pricing_plans drop constraint pricing_plans_plan_type_check;
  end if;
exception
  when undefined_table then
    null;
end $$;

alter table if exists public.pricing_plans
  add column if not exists display_name text null,
  add column if not exists description text null,
  add column if not exists active boolean not null default true,
  add column if not exists sort_order integer not null default 100,
  add column if not exists device_limit integer null,
  add column if not exists setup_fee numeric null,
  add column if not exists monthly_fee numeric null,
  add column if not exists currency text not null default 'USD',
  add column if not exists is_public boolean not null default true;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'pricing_plans_sort_order_check') then
    alter table public.pricing_plans
      add constraint pricing_plans_sort_order_check
      check (sort_order >= 0 and sort_order <= 10000);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'pricing_plans_device_limit_check') then
    alter table public.pricing_plans
      add constraint pricing_plans_device_limit_check
      check (device_limit is null or (device_limit >= 1 and device_limit <= 50));
  end if;

  if not exists (select 1 from pg_constraint where conname = 'pricing_plans_setup_fee_check') then
    alter table public.pricing_plans
      add constraint pricing_plans_setup_fee_check
      check (setup_fee is null or setup_fee >= 0);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'pricing_plans_monthly_fee_check') then
    alter table public.pricing_plans
      add constraint pricing_plans_monthly_fee_check
      check (monthly_fee is null or monthly_fee >= 0);
  end if;
end $$;

update public.pricing_plans
set
  display_name = coalesce(nullif(trim(display_name), ''), initcap(replace(plan_type, '_', ' '))),
  device_limit = coalesce(device_limit, included_devices, 2),
  setup_fee = coalesce(setup_fee, setup_base, 0),
  monthly_fee = coalesce(monthly_fee, monthly_base, 0),
  sort_order = case
    when plan_type = 'starter' then 10
    when plan_type = 'business' then 20
    when plan_type = 'growth' then 30
    when plan_type = 'app_only' then 40
    when plan_type = 'business_system' then 50
    else coalesce(sort_order, 100)
  end
where true;

-- Seed commercial plans (editable by platform admin; legacy rows retained for compatibility/demo paths).
insert into public.pricing_plans (
  plan_type,
  display_name,
  description,
  active,
  sort_order,
  device_limit,
  setup_fee,
  monthly_fee,
  currency,
  is_public,
  included_devices,
  setup_base,
  setup_per_extra,
  monthly_base,
  monthly_per_extra,
  annual_base,
  annual_months
)
values
  ('starter', 'Starter', '1 PC + 1 Phone', true, 10, 2, 10, 5, 'USD', true, 2, 10, 0, 5, 0, 60, 12),
  ('business', 'Business', 'Up to 3 devices', true, 20, 3, 25, 10, 'USD', true, 3, 25, 0, 10, 0, 120, 12),
  ('growth', 'Growth', 'Up to 6 devices', true, 30, 6, 35, 15, 'USD', true, 6, 35, 0, 15, 0, 180, 12)
on conflict (plan_type) do update
set display_name = excluded.display_name,
    description = excluded.description,
    active = excluded.active,
    sort_order = excluded.sort_order,
    device_limit = excluded.device_limit,
    setup_fee = excluded.setup_fee,
    monthly_fee = excluded.monthly_fee,
    currency = excluded.currency,
    is_public = excluded.is_public,
    included_devices = coalesce(public.pricing_plans.included_devices, excluded.included_devices),
    setup_base = coalesce(public.pricing_plans.setup_base, excluded.setup_base),
    monthly_base = coalesce(public.pricing_plans.monthly_base, excluded.monthly_base),
    annual_base = coalesce(public.pricing_plans.annual_base, excluded.annual_base),
    annual_months = coalesce(public.pricing_plans.annual_months, excluded.annual_months);

-- Hide legacy plans from the commercial admin/site defaults, but keep data for backwards compatibility.
update public.pricing_plans
set active = false,
    is_public = false,
    display_name = coalesce(display_name, initcap(replace(plan_type, '_', ' ')))
where plan_type in ('business_system', 'app_only')
  and not exists (
    select 1
    from public.pricing_plans p2
    where p2.plan_type in ('starter', 'business', 'growth')
      and p2.active = true
  );

/* -------------------------------------------------------------------------- */
/* businesses: allow dynamic plan codes (drop 2-plan check), default starter   */
/* -------------------------------------------------------------------------- */

do $$
begin
  if exists (
    select 1 from pg_constraint
    where conname = 'businesses_plan_type_check'
      and conrelid = 'public.businesses'::regclass
  ) then
    alter table public.businesses drop constraint businesses_plan_type_check;
  end if;
exception
  when undefined_table then
    null;
end $$;

alter table if exists public.businesses
  alter column plan_type set default 'starter';

update public.businesses
set plan_type = 'starter'
where plan_type is null or trim(plan_type) = '';

/* -------------------------------------------------------------------------- */
/* business_billing: explicit trial/license state fields                       */
/* -------------------------------------------------------------------------- */

alter table if exists public.business_billing
  add column if not exists trial_started_at timestamptz null,
  add column if not exists trial_ends_at timestamptz null,
  add column if not exists activated_at timestamptz null,
  add column if not exists activated_by uuid null references public.profiles (id),
  add column if not exists activation_source text null;

create index if not exists business_billing_trial_ends_idx on public.business_billing (trial_ends_at);
create index if not exists business_billing_activated_at_idx on public.business_billing (activated_at);

-- Backfill activated_at for businesses with any recorded payment.
with first_pay as (
  select business_id, min(created_at) as first_paid_at
  from public.billing_payments
  group by business_id
)
update public.business_billing bb
set activated_at = coalesce(bb.activated_at, fp.first_paid_at),
    activation_source = coalesce(bb.activation_source, 'legacy_payment')
from first_pay fp
where fp.business_id = bb.business_id
  and bb.activated_at is null;

/* -------------------------------------------------------------------------- */
/* platform_settings: singleton (trial days + EcoCash instructions)            */
/* -------------------------------------------------------------------------- */

create table if not exists public.platform_settings (
  id boolean primary key default true,
  trial_days integer not null default 14,
  payment_provider text not null default 'EcoCash',
  payment_instructions text not null default 'Pay via EcoCash and tap "I Have Paid" to send an activation request for review.',
  ecocash_number text null,
  ecocash_name text null,
  support_contact text null,
  updated_at timestamptz not null default now(),
  updated_by uuid null references public.profiles (id)
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'platform_settings_trial_days_check') then
    alter table public.platform_settings
      add constraint platform_settings_trial_days_check
      check (trial_days >= 1 and trial_days <= 90);
  end if;
end $$;

insert into public.platform_settings (id, trial_days, payment_provider, payment_instructions)
values (
  true,
  14,
  'EcoCash',
  'Pay via EcoCash, then tap "I Have Paid" in the app to notify BinanceXI POS admin. Activation is approved manually after payment verification.'
)
on conflict (id) do nothing;

drop trigger if exists set_updated_at_platform_settings on public.platform_settings;
create trigger set_updated_at_platform_settings
before update on public.platform_settings
for each row execute function public.set_updated_at();

alter table public.platform_settings enable row level security;

drop policy if exists platform_settings_select_authenticated on public.platform_settings;
create policy platform_settings_select_authenticated
on public.platform_settings
for select
to authenticated
using (true);

drop policy if exists platform_settings_write_platform on public.platform_settings;
create policy platform_settings_write_platform
on public.platform_settings
for all
to authenticated
using (public.is_platform_admin())
with check (public.is_platform_admin());

/* -------------------------------------------------------------------------- */
/* activation_requests: tenant submits, platform reviews                       */
/* -------------------------------------------------------------------------- */

create table if not exists public.activation_requests (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  requested_by uuid null references public.profiles (id) on delete set null default auth.uid(),
  requested_plan_code text null,
  payment_method text not null default 'ecocash',
  payer_name text null,
  payer_phone text null,
  payment_reference text null,
  requested_amount numeric null,
  months_requested integer not null default 1,
  message text null,
  status text not null default 'pending',
  admin_note text null,
  reviewed_by uuid null references public.profiles (id) on delete set null,
  reviewed_at timestamptz null,
  approved_amount numeric null,
  approved_months integer null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'activation_requests_status_check') then
    alter table public.activation_requests
      add constraint activation_requests_status_check
      check (status in ('pending','approved','rejected','cancelled'));
  end if;

  if not exists (select 1 from pg_constraint where conname = 'activation_requests_months_requested_check') then
    alter table public.activation_requests
      add constraint activation_requests_months_requested_check
      check (months_requested >= 1 and months_requested <= 24);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'activation_requests_approved_months_check') then
    alter table public.activation_requests
      add constraint activation_requests_approved_months_check
      check (approved_months is null or (approved_months >= 1 and approved_months <= 24));
  end if;

  if not exists (select 1 from pg_constraint where conname = 'activation_requests_requested_amount_check') then
    alter table public.activation_requests
      add constraint activation_requests_requested_amount_check
      check (requested_amount is null or requested_amount >= 0);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'activation_requests_approved_amount_check') then
    alter table public.activation_requests
      add constraint activation_requests_approved_amount_check
      check (approved_amount is null or approved_amount >= 0);
  end if;
end $$;

create index if not exists activation_requests_status_created_idx
  on public.activation_requests (status, created_at desc);
create index if not exists activation_requests_business_created_idx
  on public.activation_requests (business_id, created_at desc);
create unique index if not exists activation_requests_one_pending_per_business_idx
  on public.activation_requests (business_id)
  where status = 'pending';

drop trigger if exists set_updated_at_activation_requests on public.activation_requests;
create trigger set_updated_at_activation_requests
before update on public.activation_requests
for each row execute function public.set_updated_at();

alter table public.activation_requests enable row level security;

drop policy if exists activation_requests_select_scope on public.activation_requests;
create policy activation_requests_select_scope
on public.activation_requests
for select
to authenticated
using (
  public.is_platform_admin()
  or business_id = public.current_business_id()
);

drop policy if exists activation_requests_insert_self on public.activation_requests;
create policy activation_requests_insert_self
on public.activation_requests
for insert
to authenticated
with check (
  public.is_platform_admin()
  or (
    business_id = public.current_business_id()
    and (requested_by is null or requested_by = auth.uid())
  )
);

drop policy if exists activation_requests_update_platform on public.activation_requests;
create policy activation_requests_update_platform
on public.activation_requests
for update
to authenticated
using (public.is_platform_admin())
with check (public.is_platform_admin());

drop policy if exists activation_requests_delete_platform on public.activation_requests;
create policy activation_requests_delete_platform
on public.activation_requests
for delete
to authenticated
using (public.is_platform_admin());

/* -------------------------------------------------------------------------- */
/* platform_activity_logs: simple audit trail for commercialization actions    */
/* -------------------------------------------------------------------------- */

create table if not exists public.platform_activity_logs (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  actor_id uuid null references public.profiles (id) on delete set null,
  business_id uuid null references public.businesses (id) on delete set null,
  action text not null,
  target_type text null,
  target_id text null,
  details jsonb null
);

create index if not exists platform_activity_logs_created_idx
  on public.platform_activity_logs (created_at desc);
create index if not exists platform_activity_logs_business_idx
  on public.platform_activity_logs (business_id, created_at desc);
create index if not exists platform_activity_logs_action_idx
  on public.platform_activity_logs (action, created_at desc);

alter table public.platform_activity_logs enable row level security;

drop policy if exists platform_activity_logs_select_platform on public.platform_activity_logs;
create policy platform_activity_logs_select_platform
on public.platform_activity_logs
for select
to authenticated
using (public.is_platform_admin());

drop policy if exists platform_activity_logs_write_platform on public.platform_activity_logs;
create policy platform_activity_logs_write_platform
on public.platform_activity_logs
for insert
to authenticated
with check (public.is_platform_admin());

/* -------------------------------------------------------------------------- */
/* Helpers + RPCs                                                              */
/* -------------------------------------------------------------------------- */

create or replace function public.platform_log_action(
  p_action text,
  p_business_id uuid default null,
  p_target_type text default null,
  p_target_id text default null,
  p_details jsonb default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null or not public.is_platform_admin(v_uid) then
    raise exception 'Not authorized';
  end if;

  insert into public.platform_activity_logs (actor_id, business_id, action, target_type, target_id, details)
  values (v_uid, p_business_id, left(coalesce(p_action, 'unknown'), 120), p_target_type, p_target_id, p_details);
end;
$$;

revoke all on function public.platform_log_action(text, uuid, text, text, jsonb) from public;
grant execute on function public.platform_log_action(text, uuid, text, text, jsonb) to authenticated;

create or replace function public.ensure_business_trial_started(p_business_id uuid)
returns public.business_billing
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_trial_days integer := 14;
  v_now timestamptz := now();
  v_trial_end timestamptz;
  v_row public.business_billing%rowtype;
begin
  if p_business_id is null then
    raise exception 'Missing business_id';
  end if;

  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  if not (
    public.is_platform_admin(v_uid)
    or public.current_business_id(v_uid) = p_business_id
  ) then
    raise exception 'Not authorized';
  end if;

  insert into public.business_billing (business_id)
  values (p_business_id)
  on conflict (business_id) do nothing;

  select trial_days
  into v_trial_days
  from public.platform_settings
  where id = true;
  v_trial_days := greatest(1, least(coalesce(v_trial_days, 14), 90));

  select * into v_row
  from public.business_billing
  where business_id = p_business_id
  for update;

  if v_row.business_id is null then
    raise exception 'Missing billing row';
  end if;

  if v_row.activated_at is null and v_row.trial_started_at is null then
    v_trial_end := v_now + make_interval(days => v_trial_days);

    update public.business_billing
    set trial_started_at = v_now,
        trial_ends_at = v_trial_end,
        paid_through = v_trial_end,
        locked_override = false,
        activation_source = coalesce(activation_source, 'trial_auto_start'),
        updated_at = now()
    where business_id = p_business_id
    returning * into v_row;
  elsif v_row.activated_at is null and v_row.trial_started_at is not null and v_row.trial_ends_at is null then
    v_trial_end := greatest(v_now, coalesce(v_row.paid_through, v_now));

    update public.business_billing
    set trial_ends_at = v_trial_end,
        paid_through = v_trial_end,
        updated_at = now()
    where business_id = p_business_id
    returning * into v_row;
  end if;

  return v_row;
end;
$$;

revoke all on function public.ensure_business_trial_started(uuid) from public;
grant execute on function public.ensure_business_trial_started(uuid) to authenticated;

create or replace function public.set_business_lock(p_business_id uuid, p_locked boolean, p_note text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_locked boolean := coalesce(p_locked, false);
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

  update public.business_billing
  set locked_override = v_locked,
      updated_at = now()
  where business_id = p_business_id;

  perform public.platform_log_action(
    case when v_locked then 'business_locked' else 'business_unlocked' end,
    p_business_id,
    'business',
    p_business_id::text,
    jsonb_build_object('note', nullif(trim(coalesce(p_note, '')), ''))
  );
end;
$$;

revoke all on function public.set_business_lock(uuid, boolean, text) from public;
grant execute on function public.set_business_lock(uuid, boolean, text) to authenticated;

create or replace function public.extend_business_trial(p_business_id uuid, p_days integer, p_note text default null)
returns public.business_billing
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_days integer := greatest(1, least(coalesce(p_days, 0), 60));
  v_now timestamptz := now();
  v_row public.business_billing%rowtype;
  v_next_end timestamptz;
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

  select * into v_row
  from public.ensure_business_trial_started(p_business_id);

  if v_row.activated_at is not null then
    raise exception 'Business already activated';
  end if;

  v_next_end := greatest(coalesce(v_row.trial_ends_at, v_now), v_now) + make_interval(days => v_days);

  update public.business_billing
  set trial_ends_at = v_next_end,
      paid_through = greatest(coalesce(paid_through, v_now), v_next_end),
      locked_override = false,
      updated_at = now()
  where business_id = p_business_id
  returning * into v_row;

  perform public.platform_log_action(
    'trial_extended',
    p_business_id,
    'business',
    p_business_id::text,
    jsonb_build_object(
      'days', v_days,
      'trial_ends_at', v_next_end,
      'note', nullif(trim(coalesce(p_note, '')), '')
    )
  );

  return v_row;
end;
$$;

revoke all on function public.extend_business_trial(uuid, integer, text) from public;
grant execute on function public.extend_business_trial(uuid, integer, text) to authenticated;

create or replace function public.reject_activation_request(p_request_id uuid, p_admin_note text default null)
returns public.activation_requests
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_req public.activation_requests%rowtype;
  v_note text := nullif(trim(coalesce(p_admin_note, '')), '');
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;
  if not public.is_platform_admin(v_uid) then
    raise exception 'Not authorized';
  end if;
  if p_request_id is null then
    raise exception 'Missing request_id';
  end if;

  select * into v_req
  from public.activation_requests
  where id = p_request_id
  for update;

  if v_req.id is null then
    raise exception 'Activation request not found';
  end if;
  if v_req.status <> 'pending' then
    raise exception 'Activation request already reviewed';
  end if;

  update public.activation_requests
  set status = 'rejected',
      admin_note = v_note,
      reviewed_by = v_uid,
      reviewed_at = now(),
      updated_at = now()
  where id = p_request_id
  returning * into v_req;

  perform public.platform_log_action(
    'activation_request_rejected',
    v_req.business_id,
    'activation_request',
    v_req.id::text,
    jsonb_build_object('admin_note', v_note)
  );

  return v_req;
end;
$$;

revoke all on function public.reject_activation_request(uuid, text) from public;
grant execute on function public.reject_activation_request(uuid, text) to authenticated;

create or replace function public.approve_activation_request(
  p_request_id uuid,
  p_months integer default 1,
  p_amount numeric default null,
  p_kind text default 'manual',
  p_admin_note text default null
)
returns public.activation_requests
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_now timestamptz := now();
  v_req public.activation_requests%rowtype;
  v_bill public.business_billing%rowtype;
  v_biz public.businesses%rowtype;
  v_months integer := greatest(1, least(coalesce(p_months, 1), 24));
  v_amount numeric := null;
  v_kind text := lower(trim(coalesce(p_kind, 'manual')));
  v_admin_note text := nullif(trim(coalesce(p_admin_note, '')), '');
  v_plan record;
  v_default_amount numeric := 0;
  v_was_first_activation boolean := false;
  v_base_paid_through timestamptz;
  v_next_paid_through timestamptz;
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;
  if not public.is_platform_admin(v_uid) then
    raise exception 'Not authorized';
  end if;
  if p_request_id is null then
    raise exception 'Missing request_id';
  end if;

  select * into v_req
  from public.activation_requests
  where id = p_request_id
  for update;

  if v_req.id is null then
    raise exception 'Activation request not found';
  end if;
  if v_req.status <> 'pending' then
    raise exception 'Activation request already reviewed';
  end if;

  select * into v_biz from public.businesses where id = v_req.business_id for update;
  if v_biz.id is null then
    raise exception 'Business not found';
  end if;

  select * into v_bill
  from public.business_billing
  where business_id = v_req.business_id
  for update;

  if v_bill.business_id is null then
    insert into public.business_billing (business_id)
    values (v_req.business_id)
    on conflict (business_id) do nothing;
    select * into v_bill
    from public.business_billing
    where business_id = v_req.business_id
    for update;
  end if;

  v_bill := public.ensure_business_trial_started(v_req.business_id);
  v_was_first_activation := (v_bill.activated_at is null);

  select plan_type, setup_fee, monthly_fee
  into v_plan
  from public.pricing_plans
  where plan_type = coalesce(nullif(trim(v_biz.plan_type), ''), 'starter')
  limit 1;

  v_default_amount := coalesce(v_req.requested_amount, 0);
  if (v_default_amount is null or v_default_amount <= 0) then
    v_default_amount := coalesce(v_plan.monthly_fee, 0) * v_months;
    if v_was_first_activation then
      v_default_amount := v_default_amount + coalesce(v_plan.setup_fee, 0);
    end if;
  end if;

  v_amount := coalesce(p_amount, v_default_amount);
  if v_amount < 0 then
    v_amount := 0;
  end if;

  v_base_paid_through := greatest(coalesce(v_bill.paid_through, v_now), v_now);
  v_next_paid_through := v_base_paid_through + make_interval(days => (30 * v_months));

  update public.business_billing
  set activated_at = coalesce(activated_at, v_now),
      activated_by = coalesce(activated_by, v_uid),
      activation_source = 'manual_activation_approval',
      paid_through = v_next_paid_through,
      locked_override = false,
      updated_at = now()
  where business_id = v_req.business_id
  returning * into v_bill;

  update public.businesses
  set status = 'active',
      updated_at = now()
  where id = v_req.business_id;

  if v_amount > 0 then
    insert into public.billing_payments (
      business_id,
      amount,
      currency,
      kind,
      notes,
      created_by
    ) values (
      v_req.business_id,
      v_amount,
      'USD',
      case when v_kind in ('setup','subscription','annual','reactivation','manual') then v_kind else 'manual' end,
      coalesce(v_admin_note, 'Approved from activation request'),
      v_uid
    );
  end if;

  update public.activation_requests
  set status = 'approved',
      admin_note = v_admin_note,
      reviewed_by = v_uid,
      reviewed_at = v_now,
      approved_amount = v_amount,
      approved_months = v_months,
      updated_at = now()
  where id = p_request_id
  returning * into v_req;

  perform public.platform_log_action(
    'activation_request_approved',
    v_req.business_id,
    'activation_request',
    v_req.id::text,
    jsonb_build_object(
      'amount', v_amount,
      'months', v_months,
      'kind', case when v_kind in ('setup','subscription','annual','reactivation','manual') then v_kind else 'manual' end,
      'first_activation', v_was_first_activation,
      'paid_through', v_next_paid_through,
      'note', v_admin_note
    )
  );

  return v_req;
end;
$$;

revoke all on function public.approve_activation_request(uuid, integer, numeric, text, text) from public;
grant execute on function public.approve_activation_request(uuid, integer, numeric, text, text) to authenticated;

/* -------------------------------------------------------------------------- */
/* billing row trigger defaults: plan-aware device cap, no pre-started trial   */
/* -------------------------------------------------------------------------- */

create or replace function public.businesses_create_billing_row()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_plan text := coalesce(nullif(trim(new.plan_type), ''), 'starter');
  v_grace integer := 7;
  v_max integer := 2;
begin
  select coalesce(p.device_limit, p.included_devices, 2)
    into v_max
  from public.pricing_plans p
  where p.plan_type = v_plan
  limit 1;

  v_max := greatest(1, least(coalesce(v_max, 2), 50));

  insert into public.business_billing (business_id, grace_days, max_devices, paid_through)
  values (new.id, v_grace, v_max, now())
  on conflict (business_id) do nothing;

  return new;
end;
$$;

/* -------------------------------------------------------------------------- */
/* register_device RPC: auto-start trial on first install/login                */
/* -------------------------------------------------------------------------- */

create or replace function public.register_device(
  p_device_id text,
  p_platform text default null,
  p_label text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_business_id uuid;
  v_device_id text := nullif(trim(coalesce(p_device_id, '')), '');
  v_platform text := nullif(trim(coalesce(p_platform, '')), '');
  v_label text := nullif(trim(coalesce(p_label, '')), '');
  v_device_type text := 'unknown';
  v_max integer := 2;
  v_active_count integer := 0;
  v_is_existing boolean := false;
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  if public.is_platform_admin(v_uid) then
    return jsonb_build_object('ok', true, 'skipped', true);
  end if;

  v_business_id := public.current_business_id(v_uid);
  if v_business_id is null then
    raise exception 'Missing business context';
  end if;

  if v_device_id is null then
    raise exception 'device_id_required';
  end if;

  v_device_type := case
    when lower(coalesce(v_platform, '')) in ('android','ios') then 'phone'
    when lower(coalesce(v_platform, '')) in ('web','tauri','windows','mac','macos','linux','desktop') then 'pc'
    else 'unknown'
  end;

  perform public.ensure_business_trial_started(v_business_id);

  select coalesce(bb.max_devices, p.device_limit, p.included_devices, 2)
    into v_max
  from public.business_billing bb
  left join public.businesses b on b.id = bb.business_id
  left join public.pricing_plans p on p.plan_type = b.plan_type
  where bb.business_id = v_business_id
  limit 1;

  v_max := greatest(1, least(coalesce(v_max, 2), 50));

  select exists (
    select 1
    from public.business_devices d
    where d.business_id = v_business_id
      and d.device_id = v_device_id
      and d.active = true
  ) into v_is_existing;

  select count(*)::int
    into v_active_count
  from public.business_devices d
  where d.business_id = v_business_id
    and d.active = true;

  if not v_is_existing and v_active_count >= v_max then
    return jsonb_build_object(
      'ok', true,
      'allowed', false,
      'reason', 'device_limit_reached',
      'max_devices', v_max,
      'active_devices', v_active_count
    );
  end if;

  insert into public.business_devices (
    business_id,
    device_id,
    platform,
    device_type,
    device_label,
    active,
    registered_by,
    registered_at,
    last_seen_at
  ) values (
    v_business_id,
    v_device_id,
    coalesce(v_platform, 'unknown'),
    v_device_type,
    v_label,
    true,
    v_uid,
    now(),
    now()
  )
  on conflict (business_id, device_id)
  do update set
    platform = excluded.platform,
    device_type = excluded.device_type,
    device_label = coalesce(excluded.device_label, public.business_devices.device_label),
    active = true,
    last_seen_at = now();

  return jsonb_build_object(
    'ok', true,
    'allowed', true,
    'business_id', v_business_id,
    'device_id', v_device_id,
    'max_devices', v_max,
    'active_devices', greatest(v_active_count, 0) + case when v_is_existing then 0 else 1 end
  );
end;
$$;

revoke all on function public.register_device(text, text, text) from public;
grant execute on function public.register_device(text, text, text) to authenticated;

commit;
