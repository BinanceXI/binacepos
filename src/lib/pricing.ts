export type PlanType = "business_system" | "app_only";

function clampInt(n: number, min: number, max: number) {
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

export function computePlanPricing(planType: PlanType, devices: number): { setup: number; monthly: number } {
  const d = clampInt(devices, 1, 50);

  if (planType === "app_only") {
    const setup = 10 + 5 * Math.max(0, d - 1);
    const monthly = 5 + (d > 3 ? 10 : 0);
    return { setup, monthly };
  }

  // business_system
  const setup = 40 + 10 * Math.max(0, d - 2);
  const monthly = 15 + (d > 2 ? 20 : 0);
  return { setup, monthly };
}

