/* -------------------------------------------------------------------------- */
/* Tenant Fiscal Profiles (ZIMRA FDMS scaffolding)                            */
/* -------------------------------------------------------------------------- */

create table if not exists public.tenant_fiscal_profiles (
  tenant_id uuid primary key references public.businesses (id) on delete cascade,
  enabled boolean not null default false,
  environment text not null default 'test' check (environment in ('test', 'prod')),
  taxpayer_tin text null,
  vat_number text null,
  legal_name text null,
  trade_name text null,
  address_json jsonb null default '{}'::jsonb,
  buyer_policy text null check (buyer_policy in ('optional', 'required')),
  device_operating_mode text null check (device_operating_mode in ('Online', 'Offline', 'Hybrid')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists tenant_fiscal_profiles_enabled_idx
  on public.tenant_fiscal_profiles (enabled)
  where enabled = true;

drop trigger if exists set_updated_at_tenant_fiscal_profiles on public.tenant_fiscal_profiles;
create trigger set_updated_at_tenant_fiscal_profiles
before update on public.tenant_fiscal_profiles
for each row execute function public.set_updated_at();

alter table public.tenant_fiscal_profiles enable row level security;

drop policy if exists "tenant_fiscal_profiles_select" on public.tenant_fiscal_profiles;
create policy "tenant_fiscal_profiles_select"
on public.tenant_fiscal_profiles
for select
to authenticated
using (public.can_manage_business(tenant_id));

drop policy if exists "tenant_fiscal_profiles_insert" on public.tenant_fiscal_profiles;
create policy "tenant_fiscal_profiles_insert"
on public.tenant_fiscal_profiles
for insert
to authenticated
with check (public.can_manage_business(tenant_id));

drop policy if exists "tenant_fiscal_profiles_update" on public.tenant_fiscal_profiles;
create policy "tenant_fiscal_profiles_update"
on public.tenant_fiscal_profiles
for update
to authenticated
using (public.can_manage_business(tenant_id))
with check (public.can_manage_business(tenant_id));

revoke all on public.tenant_fiscal_profiles from public;
grant select, insert, update on public.tenant_fiscal_profiles to authenticated;
