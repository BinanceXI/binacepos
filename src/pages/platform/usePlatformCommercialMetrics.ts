import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import { supabase } from "@/lib/supabase";
import {
  computeBusinessLicenseState,
  normalizeCommercialPlanRow,
  sortPlans,
  type CommercialPlanRow,
} from "@/lib/commercialization";

type BusinessRow = {
  id: string;
  name: string;
  status: string;
  plan_type: string | null;
  created_at: string;
  business_billing?: {
    paid_through?: string | null;
    grace_days?: number | null;
    locked_override?: boolean | null;
    trial_started_at?: string | null;
    trial_ends_at?: string | null;
    activated_at?: string | null;
  } | null;
};

type DeviceLite = {
  business_id: string;
  device_type: string | null;
  active: boolean;
};

export function usePlatformCommercialMetrics() {
  const businessesQuery = useQuery({
    queryKey: ["platform", "commercialMetrics", "businesses"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("businesses")
        .select(
          "id, name, status, plan_type, created_at, business_billing(paid_through, grace_days, locked_override, trial_started_at, trial_ends_at, activated_at)"
        )
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data || []) as unknown as BusinessRow[];
    },
    staleTime: 15_000,
    refetchOnWindowFocus: false,
  });

  const devicesQuery = useQuery({
    queryKey: ["platform", "commercialMetrics", "devices"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("business_devices")
        .select("business_id, device_type, active")
        .eq("active", true)
        .limit(5000);
      if (error) throw error;
      return (data || []) as unknown as DeviceLite[];
    },
    staleTime: 15_000,
    refetchOnWindowFocus: false,
  });

  const plansQuery = useQuery({
    queryKey: ["platform", "commercialMetrics", "plans"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("pricing_plans")
        .select("plan_type, display_name, description, active, sort_order, device_limit, setup_fee, monthly_fee, currency, is_public, included_devices, setup_base, monthly_base")
        .order("sort_order", { ascending: true });
      if (error) throw error;
      return sortPlans(((data || []) as any[]).map(normalizeCommercialPlanRow));
    },
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });

  const metrics = useMemo(() => {
    const businesses = businessesQuery.data || [];
    const devices = devicesQuery.data || [];
    const plans = plansQuery.data || [];

    const planMap = new Map<string, CommercialPlanRow>();
    for (const p of plans) planMap.set(p.plan_type, p);

    const now = Date.now();
    const d30 = now - 30 * 24 * 60 * 60 * 1000;

    let total = 0;
    let active = 0;
    let trial = 0;
    let locked = 0;
    let grace = 0;
    let newBusinesses30d = 0;
    let estimatedMrr = 0;

    const planCounts = new Map<string, number>();
    const statusRows: Array<{
      id: string;
      name: string;
      plan_type: string;
      access_state: string;
      created_at: string;
    }> = [];

    for (const b of businesses) {
      total += 1;
      const state = computeBusinessLicenseState(b.status, b.business_billing || null, now);
      if (state === "trial") trial += 1;
      else if (state === "locked") locked += 1;
      else if (state === "grace") grace += 1;
      else active += 1;

      const createdMs = Date.parse(String(b.created_at || ""));
      if (Number.isFinite(createdMs) && createdMs >= d30) newBusinesses30d += 1;

      const planCode = String(b.plan_type || "starter").trim() || "starter";
      planCounts.set(planCode, (planCounts.get(planCode) || 0) + 1);

      if (state === "active" || state === "grace") {
        estimatedMrr += Number(planMap.get(planCode)?.monthly_fee || 0);
      }

      statusRows.push({
        id: b.id,
        name: b.name,
        plan_type: planCode,
        access_state: state,
        created_at: b.created_at,
      });
    }

    let activeDevices = 0;
    const deviceDistribution = { pc: 0, phone: 0, unknown: 0 };
    const devicesPerBusiness = new Map<string, number>();
    for (const d of devices) {
      if (!d.active) continue;
      activeDevices += 1;
      const type = String(d.device_type || "unknown").toLowerCase();
      if (type === "pc") deviceDistribution.pc += 1;
      else if (type === "phone") deviceDistribution.phone += 1;
      else deviceDistribution.unknown += 1;
      devicesPerBusiness.set(d.business_id, (devicesPerBusiness.get(d.business_id) || 0) + 1);
    }

    const avgDevicesPerBusiness =
      total > 0 ? Math.round((activeDevices / total) * 100) / 100 : 0;

    const planBreakdown = Array.from(planCounts.entries())
      .map(([plan_type, count]) => ({
        plan_type,
        count,
        name: planMap.get(plan_type)?.display_name || plan_type,
        monthly_fee: Number(planMap.get(plan_type)?.monthly_fee || 0),
      }))
      .sort((a, b) => b.count - a.count);

    return {
      total,
      active,
      trial,
      grace,
      locked,
      newBusinesses30d,
      estimatedMrr,
      activeDevices,
      avgDevicesPerBusiness,
      deviceDistribution,
      planBreakdown,
      businesses: statusRows,
      plans,
    };
  }, [businessesQuery.data, devicesQuery.data, plansQuery.data]);

  return {
    metrics,
    isFetching:
      businessesQuery.isFetching || devicesQuery.isFetching || plansQuery.isFetching,
    refetchAll: async () => {
      await Promise.all([
        businessesQuery.refetch(),
        devicesQuery.refetch(),
        plansQuery.refetch(),
      ]);
    },
  };
}
