import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { supabase } from "@/lib/supabase";
import {
  clampMoney,
  fmtMoney,
  normalizeCommercialPlanRow,
  slugifyPlanCode,
  sortPlans,
  toNum,
  type CommercialPlanRow,
} from "@/lib/commercialization";
import { friendlyAdminError, requirePlatformCloudSession } from "@/lib/platformAdminUtils";

import { PlatformPageHeader } from "@/components/platform/PlatformPageHeader";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";

type PlanDraft = CommercialPlanRow;

type NewPlanDraft = {
  code: string;
  name: string;
  description: string;
  device_limit: string;
  setup_fee: string;
  monthly_fee: string;
};

const EMPTY_NEW_PLAN: NewPlanDraft = {
  code: "",
  name: "",
  description: "",
  device_limit: "2",
  setup_fee: "0",
  monthly_fee: "0",
};

export function PlatformPlansPricingPage() {
  const qc = useQueryClient();
  const [drafts, setDrafts] = useState<Record<string, PlanDraft>>({});
  const [newPlan, setNewPlan] = useState<NewPlanDraft>(EMPTY_NEW_PLAN);

  const { data: plans = [], isFetching } = useQuery({
    queryKey: ["platform", "commercialPlans"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("pricing_plans")
        .select(
          "plan_type, display_name, description, active, sort_order, device_limit, setup_fee, monthly_fee, currency, is_public, included_devices, setup_base, monthly_base"
        )
        .order("sort_order", { ascending: true })
        .order("plan_type", { ascending: true });
      if (error) throw error;
      return sortPlans(((data || []) as any[]).map(normalizeCommercialPlanRow));
    },
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });

  const { data: platformSettings } = useQuery({
    queryKey: ["platform", "settings", "pricingPage"],
    queryFn: async () => {
      try {
        const { data, error } = await supabase
          .from("platform_settings")
          .select("trial_days")
          .eq("id", true)
          .maybeSingle();
        if (error) throw error;
        return data as any;
      } catch {
        return null as any;
      }
    },
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    const next: Record<string, PlanDraft> = {};
    for (const p of plans) next[p.plan_type] = { ...p };
    setDrafts(next);
  }, [plans]);

  const orderedDrafts = useMemo(
    () => sortPlans(Object.values(drafts || {})),
    [drafts]
  );

  const addDraftPlan = () => {
    const code = slugifyPlanCode(newPlan.code || newPlan.name);
    if (!code) return toast.error("Plan code or name is required");
    if (drafts[code]) return toast.error("That plan code already exists");

    const row: PlanDraft = {
      plan_type: code,
      display_name: String(newPlan.name || "").trim() || code,
      description: String(newPlan.description || "").trim() || null,
      active: true,
      sort_order: Math.max(0, Math.min(10_000, toNum(newPlan.device_limit, 2) * 10)),
      device_limit: Math.max(1, Math.min(50, toNum(newPlan.device_limit, 2))),
      setup_fee: clampMoney(newPlan.setup_fee, 0),
      monthly_fee: clampMoney(newPlan.monthly_fee, 0),
      currency: "USD",
      is_public: true,
    };

    setDrafts((d) => ({ ...d, [code]: row }));
    setNewPlan(EMPTY_NEW_PLAN);
  };

  const savePlans = async () => {
    try {
      if (!(await requirePlatformCloudSession())) return;

      const rows = orderedDrafts
        .map((p, index) => {
          const code = slugifyPlanCode(p.plan_type);
          if (!code) return null;
          const setupFee = clampMoney(p.setup_fee, 0);
          const monthlyFee = clampMoney(p.monthly_fee, 0);
          const deviceLimit = Math.max(1, Math.min(50, toNum(p.device_limit, 2)));
          return {
            plan_type: code,
            display_name: String(p.display_name || "").trim() || code,
            description: p.description ? String(p.description).trim() : null,
            active: p.active !== false,
            sort_order: Math.max(0, Math.min(10_000, toNum(p.sort_order, (index + 1) * 10))),
            device_limit: deviceLimit,
            setup_fee: setupFee,
            monthly_fee: monthlyFee,
            currency: String(p.currency || "USD").trim() || "USD",
            is_public: p.is_public !== false,
            included_devices: deviceLimit,
            setup_base: setupFee,
            setup_per_extra: 0,
            monthly_base: monthlyFee,
            monthly_per_extra: 0,
            annual_base: clampMoney(monthlyFee * 12, 0),
            annual_months: 12,
          };
        })
        .filter(Boolean);

      const { error } = await supabase
        .from("pricing_plans")
        .upsert(rows as any, { onConflict: "plan_type" });
      if (error) throw error;

      toast.success("Plans and pricing updated");
      await qc.invalidateQueries({ queryKey: ["platform", "commercialPlans"] });
      await qc.invalidateQueries({ queryKey: ["platform", "tenantHealth"] });
    } catch (e: any) {
      toast.error(friendlyAdminError(e) || "Failed to save plans");
    }
  };

  return (
    <div className="p-4 md:p-6 space-y-4">
      <PlatformPageHeader
        title="Plans & Pricing"
        subtitle="Create, disable, and edit commercial plans without changing code."
        right={
          <Button onClick={savePlans} disabled={!orderedDrafts.length}>
            Save Plans
          </Button>
        }
      />

      <Card className="shadow-card">
        <CardHeader>
          <CardTitle>Create Plan</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-6 gap-3">
          <div className="space-y-2">
            <Label>Code</Label>
            <Input
              value={newPlan.code}
              onChange={(e) =>
                setNewPlan((d) => ({ ...d, code: e.target.value }))
              }
              placeholder="starter"
            />
          </div>
          <div className="space-y-2">
            <Label>Name</Label>
            <Input
              value={newPlan.name}
              onChange={(e) =>
                setNewPlan((d) => ({ ...d, name: e.target.value }))
              }
              placeholder="Starter"
            />
          </div>
          <div className="space-y-2">
            <Label>Device limit</Label>
            <Input
              value={newPlan.device_limit}
              onChange={(e) =>
                setNewPlan((d) => ({ ...d, device_limit: e.target.value }))
              }
              inputMode="numeric"
            />
          </div>
          <div className="space-y-2">
            <Label>Setup ($)</Label>
            <Input
              value={newPlan.setup_fee}
              onChange={(e) =>
                setNewPlan((d) => ({ ...d, setup_fee: e.target.value }))
              }
              inputMode="decimal"
            />
          </div>
          <div className="space-y-2">
            <Label>Monthly ($)</Label>
            <Input
              value={newPlan.monthly_fee}
              onChange={(e) =>
                setNewPlan((d) => ({ ...d, monthly_fee: e.target.value }))
              }
              inputMode="decimal"
            />
          </div>
          <div className="flex items-end">
            <Button className="w-full" variant="outline" onClick={addDraftPlan}>
              Add Draft Plan
            </Button>
          </div>
          <div className="space-y-2 md:col-span-2 xl:col-span-6">
            <Label>Description</Label>
            <Input
              value={newPlan.description}
              onChange={(e) =>
                setNewPlan((d) => ({ ...d, description: e.target.value }))
              }
              placeholder="1 PC + 1 Phone"
            />
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        {!orderedDrafts.length ? (
          <Card className="shadow-card">
            <CardContent className="py-8 text-sm text-muted-foreground">
              {isFetching ? "Loading plans..." : "No pricing plans found."}
            </CardContent>
          </Card>
        ) : (
          orderedDrafts.map((plan) => (
            <Card key={plan.plan_type} className="shadow-card">
              <CardHeader>
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <CardTitle>{plan.display_name || plan.plan_type}</CardTitle>
                    <div className="text-xs text-muted-foreground mt-1">
                      Code: <span className="font-mono">{plan.plan_type}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant={plan.active ? "secondary" : "outline"}>
                      {plan.active ? "active" : "disabled"}
                    </Badge>
                    <Badge variant="outline">
                      {plan.currency} / {plan.device_limit} devices
                    </Badge>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div className="space-y-2">
                    <Label>Name</Label>
                    <Input
                      value={plan.display_name}
                      onChange={(e) =>
                        setDrafts((d) => ({
                          ...d,
                          [plan.plan_type]: { ...d[plan.plan_type], display_name: e.target.value },
                        }))
                      }
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Code</Label>
                    <Input
                      value={plan.plan_type}
                      onChange={(e) => {
                        const nextCode = slugifyPlanCode(e.target.value);
                        if (!nextCode) return;
                        setDrafts((d) => {
                          const current = d[plan.plan_type];
                          const copy = { ...d };
                          delete copy[plan.plan_type];
                          copy[nextCode] = { ...current, plan_type: nextCode };
                          return copy;
                        });
                      }}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Device limit</Label>
                    <Input
                      value={String(plan.device_limit)}
                      onChange={(e) =>
                        setDrafts((d) => ({
                          ...d,
                          [plan.plan_type]: {
                            ...d[plan.plan_type],
                            device_limit: Math.max(1, Math.min(50, toNum(e.target.value, plan.device_limit))),
                          },
                        }))
                      }
                      inputMode="numeric"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Sort order</Label>
                    <Input
                      value={String(plan.sort_order)}
                      onChange={(e) =>
                        setDrafts((d) => ({
                          ...d,
                          [plan.plan_type]: {
                            ...d[plan.plan_type],
                            sort_order: Math.max(0, Math.min(10_000, toNum(e.target.value, plan.sort_order))),
                          },
                        }))
                      }
                      inputMode="numeric"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Setup fee ($)</Label>
                    <Input
                      value={String(plan.setup_fee)}
                      onChange={(e) =>
                        setDrafts((d) => ({
                          ...d,
                          [plan.plan_type]: {
                            ...d[plan.plan_type],
                            setup_fee: clampMoney(e.target.value, plan.setup_fee),
                          },
                        }))
                      }
                      inputMode="decimal"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Monthly fee ($)</Label>
                    <Input
                      value={String(plan.monthly_fee)}
                      onChange={(e) =>
                        setDrafts((d) => ({
                          ...d,
                          [plan.plan_type]: {
                            ...d[plan.plan_type],
                            monthly_fee: clampMoney(e.target.value, plan.monthly_fee),
                          },
                        }))
                      }
                      inputMode="decimal"
                    />
                  </div>
                </div>

                <div className="space-y-2">
                  <Label>Description</Label>
                  <Textarea
                    value={plan.description || ""}
                    onChange={(e) =>
                      setDrafts((d) => ({
                        ...d,
                        [plan.plan_type]: {
                          ...d[plan.plan_type],
                          description: e.target.value.trim() ? e.target.value : null,
                        },
                      }))
                    }
                    rows={2}
                  />
                </div>

                <div className="flex flex-col md:flex-row gap-3 md:items-center md:justify-between rounded-xl border border-border px-3 py-3">
                  <div className="text-sm">
                    Preview: <span className="font-semibold">${fmtMoney(plan.setup_fee)}</span> setup
                    {" • "}
                    <span className="font-semibold">${fmtMoney(plan.monthly_fee)}</span>/month
                  </div>
                  <div className="flex items-center gap-4">
                    <div className="flex items-center gap-2">
                      <Switch
                        checked={plan.active}
                        onCheckedChange={(checked) =>
                          setDrafts((d) => ({
                            ...d,
                            [plan.plan_type]: { ...d[plan.plan_type], active: checked },
                          }))
                        }
                      />
                      <span className="text-sm">Enabled</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <Switch
                        checked={plan.is_public}
                        onCheckedChange={(checked) =>
                          setDrafts((d) => ({
                            ...d,
                            [plan.plan_type]: { ...d[plan.plan_type], is_public: checked },
                          }))
                        }
                      />
                      <span className="text-sm">Public</span>
                    </div>
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={() => {
                        const ok = window.confirm(
                          `Remove plan draft "${plan.display_name}" from the editor? Save to persist.`
                        );
                        if (!ok) return;
                        setDrafts((d) => {
                          const copy = { ...d };
                          delete copy[plan.plan_type];
                          return copy;
                        });
                      }}
                    >
                      Remove Draft
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))
        )}
      </div>

      <Card className="shadow-card">
        <CardContent className="py-4 text-sm text-muted-foreground">
          Trial length is configured in Platform Settings (current:{" "}
          <span className="font-semibold">{toNum(platformSettings?.trial_days, 14)} days</span>).
          Plans are stored in <span className="font-mono">pricing_plans</span> and can be changed without code edits.
        </CardContent>
      </Card>
    </div>
  );
}

export default PlatformPlansPricingPage;
