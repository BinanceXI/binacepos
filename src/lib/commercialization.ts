import { secureTime } from "@/lib/secureTime";

export type CommercialPlanRow = {
  plan_type: string;
  display_name: string;
  description: string | null;
  active: boolean;
  sort_order: number;
  device_limit: number;
  setup_fee: number;
  monthly_fee: number;
  currency: string;
  is_public: boolean;
};

export type PlatformBillingSettings = {
  trial_days: number;
  payment_provider: string;
  payment_instructions: string;
  ecocash_number: string | null;
  ecocash_name: string | null;
  support_contact: string | null;
};

export type BusinessLicenseState = "trial" | "active" | "grace" | "locked";

export type BillingLicenseRow = {
  paid_through?: string | null;
  grace_days?: number | null;
  locked_override?: boolean | null;
  trial_started_at?: string | null;
  trial_ends_at?: string | null;
  activated_at?: string | null;
};

export function toNum(v: unknown, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function clampMoney(v: unknown, fallback = 0) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.round(n * 100) / 100);
}

export function normalizeCommercialPlanRow(row: any): CommercialPlanRow {
  const code = String(row?.plan_type || "").trim();
  return {
    plan_type: code,
    display_name:
      String(row?.display_name || "").trim() || code || "Plan",
    description:
      row?.description == null ? null : String(row.description || "").trim() || null,
    active: row?.active !== false,
    sort_order: Math.max(0, Math.min(10_000, toNum(row?.sort_order, 100))),
    device_limit: Math.max(1, Math.min(50, toNum(row?.device_limit ?? row?.included_devices, 2))),
    setup_fee: clampMoney(row?.setup_fee ?? row?.setup_base, 0),
    monthly_fee: clampMoney(row?.monthly_fee ?? row?.monthly_base, 0),
    currency: String(row?.currency || "USD").trim() || "USD",
    is_public: row?.is_public !== false,
  };
}

export function sortPlans(rows: CommercialPlanRow[]) {
  return [...rows].sort((a, b) => {
    if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order;
    return a.display_name.localeCompare(b.display_name);
  });
}

export function computeBusinessLicenseState(
  businessStatus: string | null | undefined,
  billing: BillingLicenseRow | null | undefined,
  nowMs = secureTime.timestamp()
): BusinessLicenseState {
  if (!billing) return "locked";
  if (String(businessStatus || "") === "suspended") return "locked";
  if (billing.locked_override) return "locked";

  const activatedAt = billing.activated_at ? Date.parse(String(billing.activated_at)) : NaN;
  const trialEndMs = billing.trial_ends_at ? Date.parse(String(billing.trial_ends_at)) : NaN;

  if (!Number.isFinite(activatedAt)) {
    if (Number.isFinite(trialEndMs) && nowMs <= trialEndMs) return "trial";
    return "locked";
  }

  const paidMs = billing.paid_through ? Date.parse(String(billing.paid_through)) : NaN;
  if (!Number.isFinite(paidMs)) return "locked";
  if (nowMs <= paidMs) return "active";

  const graceDays = Math.max(0, Math.min(60, toNum(billing.grace_days, 0)));
  const graceEndMs = paidMs + graceDays * 24 * 60 * 60 * 1000;
  if (nowMs <= graceEndMs) return "grace";
  return "locked";
}

export function slugifyPlanCode(raw: string) {
  return String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
}

export function fmtMoney(v: unknown) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "0";
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}
