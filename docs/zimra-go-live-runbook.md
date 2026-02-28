# ZIMRA Go-Live Runbook (Multi-Tenant)

## Scope
This runbook defines the safe rollout path from FDMS test onboarding to production enablement per tenant.

## Prerequisites
- `tenant_fiscal_profiles` completed for tenant and reviewed.
- Phase C tables migrated: `fdms_tenant_credentials`, `fdms_devices`, `fdms_submission_logs`, `fdms_retry_jobs`, `fdms_audit_logs`.
- Environment configured:
  - `FDMS_ENV=test|prod`
  - `FDMS_CRED_MASTER_KEY_B64`
  - worker secret: `FDMS_WORKER_SECRET`
- Edge functions deployed: `fiscal_profile`, `fdms_health`, `fiscal_credentials`, `fiscal_devices`, `fiscal_submissions`, `fdms_worker`.

## Tenant Onboarding Checklist (Test)
1. Collect client pack:
- Legal name, trade name, taxpayer TIN, VAT number, physical address.
- Device inventory: cashier machine names/IDs, expected operating mode (Online/Offline/Hybrid).
- ZIMRA-issued onboarding details and any provided certificates/CSR requirements.

2. Configure tenant profile:
- Save profile in Settings → ZIMRA Fiscalisation.
- Keep `enabled=false` until test verification passes.

3. Register credentials:
- Upload client cert/key through `fiscal_credentials` (test environment).
- Verify encrypted credential row created and audit log recorded.

4. Register device records:
- Add each device in `fiscal_devices` with initial `pending` states.

5. Connectivity smoke tests:
- Call `fdms_health`.
- Run one controlled `fiscal_submissions` test payload and validate log + retry state transitions.

## UAT Signoff
- Validate day lifecycle flow in test: open day → submit test receipts/files → close day.
- Confirm reconciliation visibility in `fdms_submission_logs` and `fdms_retry_jobs`.
- Confirm tenant isolation by querying another tenant as control.

## Production Cutover
1. Freeze tenant POS release window.
2. Rotate/upload production credentials with `environment=prod` and set active.
3. Switch fiscal profile environment to `prod`.
4. Enable `tenant_fiscal_profiles.enabled=true`.
5. Run first production health check and first monitored submission.

## Rollback
- Set `tenant_fiscal_profiles.enabled=false` for affected tenant.
- Mark failing device/submission state with reason in `fdms_devices.last_error` and `fdms_submission_logs.error_message`.
- Pause retries by setting related `fdms_retry_jobs.status='dead_letter'` with reason.
- Revert tenant profile environment back to `test` if needed.

## Operational Controls
- Review `fdms_retry_jobs` dead-letter queue daily.
- Audit all credential/device changes through `fdms_audit_logs`.
- Enforce credential rotation policy per tenant.
- Keep test and prod credential versions separate and labeled.
