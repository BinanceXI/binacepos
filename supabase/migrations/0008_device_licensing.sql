-- BinanceXI POS (by Binance Labs)
-- Device licensing: limit active devices per business (default 2).

begin;

/* -------------------------------------------------------------------------- */
/* business_billing: max_devices                                              */
/* -------------------------------------------------------------------------- */

alter table if exists public.business_billing
  add column if not exists max_devices integer not null default 2;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'business_billing_max_devices_check') then
    alter table public.business_billing
      add constraint business_billing_max_devices_check
      check (max_devices >= 1 and max_devices <= 50);
  end if;
end $$;

/* -------------------------------------------------------------------------- */
/* business_devices                                                           */
/* -------------------------------------------------------------------------- */

create table if not exists public.business_devices (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  device_id text not null,
  platform text not null default 'unknown',
  device_label text null,
  active boolean not null default true,
  registered_by uuid null default auth.uid(),
  registered_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'business_devices_business_device_unique') then
    alter table public.business_devices
      add constraint business_devices_business_device_unique
      unique (business_id, device_id);
  end if;
end $$;

create index if not exists business_devices_business_active_idx
  on public.business_devices (business_id, active);
create index if not exists business_devices_last_seen_idx
  on public.business_devices (business_id, last_seen_at desc);

/* -------------------------------------------------------------------------- */
/* RLS                                                                        */
/* -------------------------------------------------------------------------- */

alter table public.business_devices enable row level security;

drop policy if exists business_devices_select_platform on public.business_devices;
create policy business_devices_select_platform
on public.business_devices
for select
to authenticated
using (public.is_platform_admin());

drop policy if exists business_devices_select_self on public.business_devices;
create policy business_devices_select_self
on public.business_devices
for select
to authenticated
using (business_id = public.current_business_id());

drop policy if exists business_devices_write_platform on public.business_devices;
create policy business_devices_write_platform
on public.business_devices
for all
to authenticated
using (public.is_platform_admin())
with check (public.is_platform_admin());

/* -------------------------------------------------------------------------- */
/* RPC: register_device                                                       */
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
  v_max integer := 2;
  v_active_count integer := 0;
  v_is_existing boolean := false;
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  if public.is_platform_admin(v_uid) then
    -- Platform admins are not device-limited.
    return jsonb_build_object('ok', true, 'skipped', true);
  end if;

  v_business_id := public.current_business_id(v_uid);
  if v_business_id is null then
    raise exception 'Missing business context';
  end if;

  if v_device_id is null then
    raise exception 'device_id_required';
  end if;

  select coalesce(bb.max_devices, 2)
    into v_max
  from public.business_billing bb
  where bb.business_id = v_business_id
  limit 1;

  select exists (
    select 1
    from public.business_devices d
    where d.business_id = v_business_id
      and d.device_id = v_device_id
      and d.active = true
  )
    into v_is_existing;

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
    device_label,
    active,
    registered_by,
    registered_at,
    last_seen_at
  ) values (
    v_business_id,
    v_device_id,
    coalesce(v_platform, 'unknown'),
    v_label,
    true,
    v_uid,
    now(),
    now()
  )
  on conflict (business_id, device_id)
  do update set
    platform = excluded.platform,
    device_label = coalesce(excluded.device_label, business_devices.device_label),
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

