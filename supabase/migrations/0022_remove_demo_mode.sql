begin;

-- Purge demo tenants and their tenant-scoped data before removing demo schema flags.
do $$
declare
  demo_business_ids uuid[] := '{}';
  rec record;
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'businesses'
      and column_name = 'is_demo'
  ) then
    select coalesce(array_agg(id), '{}')
      into demo_business_ids
    from public.businesses
    where coalesce(is_demo, false) = true;

    if array_length(demo_business_ids, 1) is not null then
      for rec in
        select distinct c.table_name
        from information_schema.columns c
        where c.table_schema = 'public'
          and c.column_name = 'business_id'
          and c.table_name <> 'businesses'
      loop
        execute format('delete from public.%I where business_id = any($1)', rec.table_name)
          using demo_business_ids;
      end loop;

      delete from public.businesses
      where id = any(demo_business_ids);
    end if;
  end if;
end
$$;

drop table if exists public.demo_sessions cascade;
drop table if exists public.demo_cleanup_audit cascade;
drop index if exists businesses_is_demo_idx;
alter table public.businesses drop column if exists is_demo;

-- Recreate platform RPCs without demo predicates.
create or replace function public.platform_kpis()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_now timestamptz := now();
  v_30d timestamptz := v_now - interval '30 days';
  v_7d timestamptz := v_now - interval '7 days';

  v_total_businesses int := 0;
  v_active_businesses int := 0;
  v_suspended_businesses int := 0;
  v_locked int := 0;
  v_grace int := 0;

  v_payments_total numeric := 0;
  v_payments_count int := 0;

  v_orders_count int := 0;
  v_orders_total numeric := 0;

  v_feedback_new int := 0;
  v_feedback_open int := 0;

  v_active_devices int := 0;
  v_seen_24h int := 0;
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;
  if not public.is_platform_admin(v_uid) then
    raise exception 'Not authorized';
  end if;

  select count(*)::int
    into v_total_businesses
  from public.businesses;

  select count(*)::int
    into v_active_businesses
  from public.businesses
  where status = 'active';

  select count(*)::int
    into v_suspended_businesses
  from public.businesses
  where status = 'suspended';

  with s as (
    select
      b.id,
      b.status,
      bb.paid_through,
      bb.grace_days,
      bb.locked_override,
      case
        when b.status = 'suspended' or bb.locked_override = true then 'locked'
        when v_now <= bb.paid_through then 'active'
        when v_now <= (bb.paid_through + make_interval(days => bb.grace_days)) then 'grace'
        else 'locked'
      end as access_state
    from public.businesses b
    left join public.business_billing bb on bb.business_id = b.id
  )
  select
    sum(case when access_state = 'locked' then 1 else 0 end)::int,
    sum(case when access_state = 'grace' then 1 else 0 end)::int
  into v_locked, v_grace
  from s;

  select
    coalesce(sum(p.amount), 0),
    count(*)::int
  into v_payments_total, v_payments_count
  from public.billing_payments p
  join public.businesses b on b.id = p.business_id
  where p.created_at >= v_30d;

  select
    count(*)::int,
    coalesce(sum(o.total_amount), 0)
  into v_orders_count, v_orders_total
  from public.orders o
  join public.businesses b on b.id = o.business_id
  where o.created_at >= v_7d;

  select
    sum(case when f.status = 'new' then 1 else 0 end)::int,
    sum(case when f.status in ('new','triaged','in_progress') then 1 else 0 end)::int
  into v_feedback_new, v_feedback_open
  from public.app_feedback f
  join public.businesses b on b.id = f.business_id;

  select count(*)::int
    into v_active_devices
  from public.business_devices d
  join public.businesses b on b.id = d.business_id
  where d.active = true;

  select count(*)::int
    into v_seen_24h
  from public.business_devices d
  join public.businesses b on b.id = d.business_id
  where d.last_seen_at >= (v_now - interval '24 hours');

  return jsonb_build_object(
    'ok', true,
    'generated_at', v_now,
    'tenants', jsonb_build_object(
      'total', v_total_businesses,
      'active', v_active_businesses,
      'suspended', v_suspended_businesses,
      'locked', coalesce(v_locked, 0),
      'grace', coalesce(v_grace, 0)
    ),
    'payments_30d', jsonb_build_object(
      'total_amount', v_payments_total,
      'count', v_payments_count
    ),
    'orders_7d', jsonb_build_object(
      'count', v_orders_count,
      'total_amount', v_orders_total
    ),
    'feedback', jsonb_build_object(
      'new', coalesce(v_feedback_new, 0),
      'open', coalesce(v_feedback_open, 0)
    ),
    'devices', jsonb_build_object(
      'active', coalesce(v_active_devices, 0),
      'seen_24h', coalesce(v_seen_24h, 0)
    )
  );
end;
$$;

revoke all on function public.platform_kpis() from public;
grant execute on function public.platform_kpis() to authenticated;

create or replace function public.platform_tenant_health()
returns table (
  business_id uuid,
  name text,
  status text,
  plan_type text,
  paid_through timestamptz,
  grace_days integer,
  locked_override boolean,
  max_devices integer,
  active_devices integer,
  last_seen_at timestamptz,
  last_order_at timestamptz,
  access_state text
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_now timestamptz := now();
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;
  if not public.is_platform_admin(v_uid) then
    raise exception 'Not authorized';
  end if;

  return query
    with dev as (
      select
        d.business_id,
        (count(*) filter (where d.active = true))::int as active_devices,
        max(d.last_seen_at) as last_seen_at
      from public.business_devices d
      group by d.business_id
    ),
    ord as (
      select
        o.business_id,
        max(o.created_at) as last_order_at
      from public.orders o
      group by o.business_id
    )
    select
      b.id as business_id,
      b.name,
      b.status,
      coalesce(nullif(trim(b.plan_type), ''), 'business_system') as plan_type,
      bb.paid_through,
      bb.grace_days,
      bb.locked_override,
      bb.max_devices,
      coalesce(dev.active_devices, 0) as active_devices,
      dev.last_seen_at,
      ord.last_order_at,
      case
        when b.status = 'suspended' or bb.locked_override = true then 'locked'
        when v_now <= bb.paid_through then 'active'
        when v_now <= (bb.paid_through + make_interval(days => bb.grace_days)) then 'grace'
        else 'locked'
      end as access_state
    from public.businesses b
    left join public.business_billing bb on bb.business_id = b.id
    left join dev on dev.business_id = b.id
    left join ord on ord.business_id = b.id
    order by b.created_at desc;
end;
$$;

revoke all on function public.platform_tenant_health() from public;
grant execute on function public.platform_tenant_health() to authenticated;

commit;
