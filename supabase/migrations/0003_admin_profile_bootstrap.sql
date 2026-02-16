-- Safe admin bootstrap for first authenticated user only.

begin;

create or replace function public.bootstrap_profile_if_empty(
  p_username text default null,
  p_full_name text default null
)
returns public.profiles
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_profile public.profiles%rowtype;
  v_username text;
  v_count bigint;
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  select * into v_profile
  from public.profiles
  where id = v_uid;

  if found then
    return v_profile;
  end if;

  select count(*) into v_count from public.profiles;
  if v_count > 0 then
    raise exception 'Profile bootstrap is only allowed when profiles is empty';
  end if;

  v_username := lower(coalesce(p_username, 'owner'));
  v_username := regexp_replace(v_username, '[^a-z0-9._-]', '', 'g');
  if length(v_username) < 3 then
    v_username := 'owner';
  end if;

  if exists (select 1 from public.profiles where username = v_username) then
    v_username := v_username || '_' || substr(replace(v_uid::text, '-', ''), 1, 6);
  end if;

  insert into public.profiles (
    id,
    username,
    full_name,
    role,
    permissions,
    active
  ) values (
    v_uid,
    v_username,
    nullif(trim(p_full_name), ''),
    'admin',
    jsonb_build_object(
      'allowRefunds', true,
      'allowVoid', true,
      'allowPriceEdit', true,
      'allowDiscount', true,
      'allowReports', true,
      'allowInventory', true,
      'allowSettings', true,
      'allowEditReceipt', true
    ),
    true
  )
  returning * into v_profile;

  return v_profile;
end;
$$;

revoke all on function public.bootstrap_profile_if_empty(text, text) from public;
grant execute on function public.bootstrap_profile_if_empty(text, text) to authenticated;

commit;
