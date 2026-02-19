-- BinanceXI POS: deterministic demo cleanup auditing + production parity for demo_sessions

begin;

alter table if exists public.demo_sessions
  add column if not exists purged_at timestamptz null,
  add column if not exists purge_attempts integer not null default 0,
  add column if not exists last_purge_error text null;

create index if not exists demo_sessions_expires_purged_idx
  on public.demo_sessions (expires_at, purged_at);

create table if not exists public.demo_cleanup_audit (
  id uuid primary key default gen_random_uuid(),
  demo_session_id uuid null,
  business_id uuid null,
  user_id uuid null,
  status text not null,
  error text null,
  created_at timestamptz not null default now()
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'demo_cleanup_audit_status_check') then
    alter table public.demo_cleanup_audit
      add constraint demo_cleanup_audit_status_check
      check (status in ('success','failed'));
  end if;
end $$;

create index if not exists demo_cleanup_audit_created_idx
  on public.demo_cleanup_audit (created_at desc);

create index if not exists demo_cleanup_audit_business_idx
  on public.demo_cleanup_audit (business_id, created_at desc);

alter table public.demo_cleanup_audit enable row level security;
-- No policies: server-only audit table.

commit;
