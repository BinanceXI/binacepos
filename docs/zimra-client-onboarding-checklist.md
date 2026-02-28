# ZIMRA Tenant Onboarding Checklist (Per Business/Tenant)

Use this checklist before enabling `tenant_fiscal_profiles.enabled=true`.

## 1) Legal and Tax Identity
- Legal business name (as registered with ZIMRA)
- Trade name (if different)
- Taxpayer TIN
- VAT number
- Registered physical address (JSON-ready object for tenant profile)

## 2) FDMS Environment and Go-Live Path
- Target environment for onboarding: `test` first, then `prod`
- Approval owner (client-side contact who signs off UAT)
- Go-live date and rollback owner

## 3) Device and Site Registration Inputs
- Device identifier(s) per outlet/register
- Branch/store mapping per device
- Operating mode per device: `Online`, `Offline`, or `Hybrid`
- Connectivity profile per site (stable internet vs intermittent)

## 4) Certificate and Security Inputs
- Client mTLS certificate PEM
- Client mTLS private key PEM
- Optional CA certificate PEM
- Certificate rotation contact and rotation date policy

## 5) Receipt and Submission Readiness
- Receipt numbering format policy (per tenant/device)
- Buyer policy decision: `optional` or `required`
- File submission obligations and retention policy
- Recovery/retry expectations for temporary network failure

## 6) Historical Data Migration (Master + Opening)
- Product master (name, SKU, barcode, category, type, sell price, cost, threshold)
- Opening stock snapshot (quantity and valuation basis)
- Customers/suppliers master (if tenant schema supports them)
- Opening balances file (if tenant schema supports them)

## 7) Operational Contacts
- Business owner
- Finance/tax contact
- Technical contact for printer/device setup
- Escalation contact for failed submissions

## 8) Final Enablement Controls
- Keep fiscal profile disabled during setup/UAT
- Run FDMS health endpoint check
- Validate device registration + certificate issuance
- Validate first test receipt submission and status reconciliation
- Enable tenant fiscal profile only after successful end-to-end test
