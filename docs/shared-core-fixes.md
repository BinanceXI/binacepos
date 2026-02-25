# Shared Core Fix Boundaries (BinanceXI <-> Masters)

This repo now has small shared core modules intended for safe cross-repo ports without copying business-specific customizations:

- `src/core/receipts/receiptPrintModel.ts`
  - Canonical receipt print model (header/meta/items/totals/verification payload)
  - Shared by desktop receipt UI and mobile thermal printing
- `src/core/reports/reportMetrics.ts`
  - Order cache helpers, offline queue -> order conversion, metric aggregation
- `src/core/auth-gates/reportsSessionGate.ts`
  - Reports auth/offline gate with user-safe offline banner behavior

## Porting Rule

Port only these core modules and the minimal call sites that consume them. Do not copy:

- branding assets/config (`src/assets/*`, `src/lib/brand.ts`) without replacing with repo-specific branding
- Supabase URLs/keys/env files
- tenant/business-specific UI text or client-specific custom pages

## Port Checklist (per fix)

1. Port/update the relevant `src/core/*` module.
2. Patch BinanceXI/Masters call sites to consume the shared module output.
3. Keep each repo's `BRAND` config and receipt branding assets separate.
4. Run `npm run build` in each repo after porting.

