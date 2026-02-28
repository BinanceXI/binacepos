begin;

create table if not exists public.fdms_tenant_credentials (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.businesses(id) on delete cascade,
  environment text not null default 'test' check (environment in ('test', 'prod')),
  key_version integer not null default 1,
  encrypted_client_cert text not null,
  encrypted_client_key text not null,
  encrypted_ca_cert text null,
  active boolean not null default true,
  rotated_at timestamptz null,
  created_by uuid null references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, environment, key_version)
);

create index if not exists fdms_tenant_credentials_tenant_active_idx
  on public.fdms_tenant_credentials(tenant_id, active);

drop trigger if exists set_updated_at_fdms_tenant_credentials on public.fdms_tenant_credentials;
create trigger set_updated_at_fdms_tenant_credentials
before update on public.fdms_tenant_credentials
for each row execute function public.set_updated_at();

create table if not exists public.fdms_devices (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.businesses(id) on delete cascade,
  device_identifier text not null,
  fdms_device_id text null,
  registration_status text not null default 'pending'
    check (registration_status in ('pending', 'registered', 'failed')),
  certificate_status text not null default 'pending'
    check (certificate_status in ('pending', 'issued', 'failed')),
  config_sync_status text not null default 'pending'
    check (config_sync_status in ('pending', 'synced', 'failed')),
  day_state text not null default 'closed'
    check (day_state in ('open', 'closed')),
  last_heartbeat_at timestamptz null,
  last_error text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, device_identifier)
);

create index if not exists fdms_devices_tenant_idx on public.fdms_devices(tenant_id);
create index if not exists fdms_devices_registration_idx on public.fdms_devices(registration_status);

drop trigger if exists set_updated_at_fdms_devices on public.fdms_devices;
create trigger set_updated_at_fdms_devices
before update on public.fdms_devices
for each row execute function public.set_updated_at();

create table if not exists public.fdms_submission_logs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.businesses(id) on delete cascade,
  device_id uuid null references public.fdms_devices(id) on delete set null,
  submission_type text not null check (submission_type in ('receipt', 'file')),
  request_hash text null,
  idempotency_key text null,
  status text not null default 'queued'
    check (status in ('queued', 'submitted', 'accepted', 'rejected', 'failed')),
  fdms_reference text null,
  request_payload jsonb null,
  response_payload jsonb null,
  response_excerpt text null,
  error_message text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, idempotency_key)
);

create index if not exists fdms_submission_logs_tenant_status_idx
  on public.fdms_submission_logs(tenant_id, status, created_at desc);
create index if not exists fdms_submission_logs_request_hash_idx
  on public.fdms_submission_logs(request_hash);

drop trigger if exists set_updated_at_fdms_submission_logs on public.fdms_submission_logs;
create trigger set_updated_at_fdms_submission_logs
before update on public.fdms_submission_logs
for each row execute function public.set_updated_at();

create table if not exists public.fdms_retry_jobs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.businesses(id) on delete cascade,
  submission_log_id uuid not null references public.fdms_submission_logs(id) on delete cascade,
  job_type text not null check (job_type in ('submit_receipt', 'submit_file', 'status_poll')),
  status text not null default 'pending'
    check (status in ('pending', 'running', 'completed', 'dead_letter')),
  attempt_count integer not null default 0,
  max_attempts integer not null default 8,
  next_run_at timestamptz not null default now(),
  last_error text null,
  dead_letter_reason text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists fdms_retry_jobs_run_idx
  on public.fdms_retry_jobs(status, next_run_at);
create index if not exists fdms_retry_jobs_tenant_idx
  on public.fdms_retry_jobs(tenant_id, status);

drop trigger if exists set_updated_at_fdms_retry_jobs on public.fdms_retry_jobs;
create trigger set_updated_at_fdms_retry_jobs
before update on public.fdms_retry_jobs
for each row execute function public.set_updated_at();

create table if not exists public.fdms_audit_logs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.businesses(id) on delete cascade,
  actor_user_id uuid null references public.profiles(id) on delete set null,
  action text not null,
  entity_type text not null,
  entity_id text null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists fdms_audit_logs_tenant_created_idx
  on public.fdms_audit_logs(tenant_id, created_at desc);

alter table public.fdms_tenant_credentials enable row level security;
alter table public.fdms_devices enable row level security;
alter table public.fdms_submission_logs enable row level security;
alter table public.fdms_retry_jobs enable row level security;
alter table public.fdms_audit_logs enable row level security;

drop policy if exists "fdms_tenant_credentials_select" on public.fdms_tenant_credentials;
create policy "fdms_tenant_credentials_select"
on public.fdms_tenant_credentials
for select to authenticated
using (public.can_manage_business(tenant_id));

drop policy if exists "fdms_tenant_credentials_insert" on public.fdms_tenant_credentials;
create policy "fdms_tenant_credentials_insert"
on public.fdms_tenant_credentials
for insert to authenticated
with check (public.can_manage_business(tenant_id));

drop policy if exists "fdms_tenant_credentials_update" on public.fdms_tenant_credentials;
create policy "fdms_tenant_credentials_update"
on public.fdms_tenant_credentials
for update to authenticated
using (public.can_manage_business(tenant_id))
with check (public.can_manage_business(tenant_id));

drop policy if exists "fdms_devices_select" on public.fdms_devices;
create policy "fdms_devices_select"
on public.fdms_devices
for select to authenticated
using (public.can_manage_business(tenant_id));

drop policy if exists "fdms_devices_insert" on public.fdms_devices;
create policy "fdms_devices_insert"
on public.fdms_devices
for insert to authenticated
with check (public.can_manage_business(tenant_id));

drop policy if exists "fdms_devices_update" on public.fdms_devices;
create policy "fdms_devices_update"
on public.fdms_devices
for update to authenticated
using (public.can_manage_business(tenant_id))
with check (public.can_manage_business(tenant_id));

drop policy if exists "fdms_submission_logs_select" on public.fdms_submission_logs;
create policy "fdms_submission_logs_select"
on public.fdms_submission_logs
for select to authenticated
using (public.can_manage_business(tenant_id));

drop policy if exists "fdms_submission_logs_insert" on public.fdms_submission_logs;
create policy "fdms_submission_logs_insert"
on public.fdms_submission_logs
for insert to authenticated
with check (public.can_manage_business(tenant_id));

drop policy if exists "fdms_submission_logs_update" on public.fdms_submission_logs;
create policy "fdms_submission_logs_update"
on public.fdms_submission_logs
for update to authenticated
using (public.can_manage_business(tenant_id))
with check (public.can_manage_business(tenant_id));

drop policy if exists "fdms_retry_jobs_select" on public.fdms_retry_jobs;
create policy "fdms_retry_jobs_select"
on public.fdms_retry_jobs
for select to authenticated
using (public.can_manage_business(tenant_id));

drop policy if exists "fdms_retry_jobs_insert" on public.fdms_retry_jobs;
create policy "fdms_retry_jobs_insert"
on public.fdms_retry_jobs
for insert to authenticated
with check (public.can_manage_business(tenant_id));

drop policy if exists "fdms_retry_jobs_update" on public.fdms_retry_jobs;
create policy "fdms_retry_jobs_update"
on public.fdms_retry_jobs
for update to authenticated
using (public.can_manage_business(tenant_id))
with check (public.can_manage_business(tenant_id));

drop policy if exists "fdms_audit_logs_select" on public.fdms_audit_logs;
create policy "fdms_audit_logs_select"
on public.fdms_audit_logs
for select to authenticated
using (public.can_manage_business(tenant_id));

drop policy if exists "fdms_audit_logs_insert" on public.fdms_audit_logs;
create policy "fdms_audit_logs_insert"
on public.fdms_audit_logs
for insert to authenticated
with check (public.can_manage_business(tenant_id));

revoke all on public.fdms_tenant_credentials from public;
revoke all on public.fdms_devices from public;
revoke all on public.fdms_submission_logs from public;
revoke all on public.fdms_retry_jobs from public;
revoke all on public.fdms_audit_logs from public;

grant select, insert, update on public.fdms_tenant_credentials to authenticated;
grant select, insert, update on public.fdms_devices to authenticated;
grant select, insert, update on public.fdms_submission_logs to authenticated;
grant select, insert, update on public.fdms_retry_jobs to authenticated;
grant select, insert on public.fdms_audit_logs to authenticated;

commit;
