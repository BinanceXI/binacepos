# Verschard Investments ZIMRA Onboarding (Execution Checklist)

Use this for the current tenant rollout. Keep fiscalisation disabled until the full test cycle passes.

## 1) Client Data You Must Collect
- Legal name: `Verschard Investments` (confirm exact ZIMRA-registered spelling)
- Trade name (if different)
- TIN
- VAT number
- Registered address (street, city, province, country, postal code)
- Buyer policy: `optional` or `required`
- Device operating mode: `Online`, `Offline`, or `Hybrid`

## 2) Device Inventory to Register
- Device 1: phone POS (fiscal device yes/no)
- Device 2: PC-1 POS (fiscal device yes/no)
- Device 3: PC-2 POS (fiscal device yes/no)
- Device 4: PC-3 POS (fiscal device yes/no)
- Browser dev machine: admin workstation only (recommended non-fiscal)

For each fiscal device capture:
- Internal device code
- Branch/outlet mapping
- Responsible operator

## 3) Security Material Required From Client
- `FDMS_CLIENT_CERT_PEM`
- `FDMS_CLIENT_KEY_PEM`
- `FDMS_CA_CERT_PEM` (optional, if provided by ZIMRA/client PKI)

## 4) Tenant Setup Sequence (Test First)
1. Save fiscal profile in Settings -> ZIMRA Fiscalisation with `enabled=false`, `environment=test`.
2. Upload encrypted credentials through fiscal credentials endpoint.
3. Register devices in fiscal devices endpoint.
4. Run `GET /api/fiscal/fdms/health`.
5. Submit controlled test receipt/file payloads and confirm status lifecycle.
6. Verify audit/submission logs and retry queue behavior.
7. Only after UAT signoff: rotate/confirm prod certs, switch profile `environment=prod`, then set `enabled=true`.

## 5) Legacy SQL Migration Path (Master + Opening)
For SQL data from previous system, migrate in two passes:
1. Master import:
   - products, categories, customers, suppliers
2. Opening import:
   - opening stock quantities/values and opening balances

Use script:
- `scripts/import_tenant_master_opening.mjs`

Run in `--dry-run` first, review reconciliation output, then run commit mode.
