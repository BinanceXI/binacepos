-- BinanceXI POS
-- P11: Infer device_type (pc/phone) during register_device.

begin;

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

  v_device_type := case
    when lower(coalesce(v_platform, '')) in ('android','ios') then 'phone'
    when lower(coalesce(v_platform, '')) in ('web','tauri','windows','mac','macos','linux','desktop') then 'pc'
    else 'unknown'
  end;

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

-- Best-effort backfill for existing devices.
update public.business_devices
set device_type = case
  when lower(coalesce(platform, '')) in ('android','ios') then 'phone'
  when lower(coalesce(platform, '')) in ('web','tauri','windows','mac','macos','linux','desktop') then 'pc'
  else 'unknown'
end
where device_type = 'unknown';

commit;

