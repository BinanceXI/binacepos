begin;

do $$
begin
  if exists (select 1 from pg_constraint where conname = 'profiles_role_check') then
    alter table public.profiles drop constraint profiles_role_check;
  end if;
end $$;

alter table public.profiles
  add constraint profiles_role_check
  check (role in ('platform_admin', 'master_admin', 'super_admin', 'admin', 'cashier'));

create or replace function public.is_platform_admin(p_uid uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles p
    where p.id = coalesce(p_uid, auth.uid())
      and p.active is distinct from false
      and p.role in ('platform_admin', 'master_admin', 'super_admin')
  )
$$;

revoke all on function public.is_platform_admin(uuid) from public;
grant execute on function public.is_platform_admin(uuid) to authenticated;

commit;
