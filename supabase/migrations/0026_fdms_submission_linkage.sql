begin;

alter table public.fdms_submission_logs
  add column if not exists device_identifier text null,
  add column if not exists order_id uuid null references public.orders(id) on delete set null,
  add column if not exists receipt_id text null,
  add column if not exists receipt_number text null;

create index if not exists fdms_submission_logs_order_idx
  on public.fdms_submission_logs(order_id);

create index if not exists fdms_submission_logs_receipt_idx
  on public.fdms_submission_logs(tenant_id, receipt_id);

create index if not exists fdms_submission_logs_device_identifier_idx
  on public.fdms_submission_logs(tenant_id, device_identifier);

commit;
