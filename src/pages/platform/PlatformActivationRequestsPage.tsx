import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { supabase } from "@/lib/supabase";
import { fmtMoney, normalizeCommercialPlanRow, sortPlans, type CommercialPlanRow } from "@/lib/commercialization";
import { friendlyAdminError, requirePlatformCloudSession } from "@/lib/platformAdminUtils";

import { PlatformPageHeader } from "@/components/platform/PlatformPageHeader";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

type ActivationRequestListRow = {
  id: string;
  business_id: string;
  requested_by: string | null;
  requested_plan_code: string | null;
  payment_method: string;
  payer_name: string | null;
  payer_phone: string | null;
  payment_reference: string | null;
  requested_amount: number | null;
  months_requested: number;
  message: string | null;
  status: "pending" | "approved" | "rejected" | "cancelled" | string;
  admin_note: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  approved_amount: number | null;
  approved_months: number | null;
  created_at: string;
  businesses?: { name?: string | null; status?: string | null; plan_type?: string | null } | null;
};

type TenantHealthLite = {
  business_id: string;
  access_state?: string | null;
  locked_override?: boolean | null;
};

export function PlatformActivationRequestsPage() {
  const qc = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<"pending" | "all">("pending");
  const [search, setSearch] = useState("");

  const { data: requests = [], isFetching } = useQuery({
    queryKey: ["platform", "activationRequests", statusFilter],
    queryFn: async () => {
      let q = supabase
        .from("activation_requests")
        .select(
          "id, business_id, requested_by, requested_plan_code, payment_method, payer_name, payer_phone, payment_reference, requested_amount, months_requested, message, status, admin_note, reviewed_by, reviewed_at, approved_amount, approved_months, created_at, businesses(name, status, plan_type)"
        )
        .order("created_at", { ascending: false })
        .limit(300);
      if (statusFilter !== "all") q = q.eq("status", statusFilter);
      const { data, error } = await q;
      if (error) throw error;
      return (data || []) as unknown as ActivationRequestListRow[];
    },
    staleTime: 10_000,
    refetchOnWindowFocus: false,
  });

  const { data: plans = [] } = useQuery({
    queryKey: ["platform", "commercialPlans", "activationPage"],
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

  const { data: tenantHealth = [] } = useQuery({
    queryKey: ["platform", "tenantHealth", "activationPage"],
    queryFn: async () => {
      try {
        const { data, error } = await supabase.rpc("platform_tenant_health");
        if (error) throw error;
        return ((data || []) as any[]).map((r) => ({
          business_id: String(r.business_id || ""),
          access_state: r.access_state ? String(r.access_state) : null,
          locked_override: r.locked_override === true,
        })) as TenantHealthLite[];
      } catch {
        return [] as TenantHealthLite[];
      }
    },
    staleTime: 15_000,
    refetchOnWindowFocus: false,
  });

  const planMap = useMemo(() => {
    const m = new Map<string, CommercialPlanRow>();
    for (const p of plans) m.set(p.plan_type, p);
    return m;
  }, [plans]);

  const healthMap = useMemo(() => {
    const m = new Map<string, TenantHealthLite>();
    for (const h of tenantHealth) m.set(h.business_id, h);
    return m;
  }, [tenantHealth]);

  const filteredRequests = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return requests;
    return requests.filter((r) => {
      const name = String(r.businesses?.name || "").toLowerCase();
      return (
        name.includes(q) ||
        String(r.business_id || "").toLowerCase().includes(q) ||
        String(r.payment_reference || "").toLowerCase().includes(q) ||
        String(r.payer_name || "").toLowerCase().includes(q) ||
        String(r.payer_phone || "").toLowerCase().includes(q)
      );
    });
  }, [requests, search]);

  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: ["platform", "activationRequests"] });
    await qc.invalidateQueries({ queryKey: ["platform", "tenantHealth"] });
    await qc.invalidateQueries({ queryKey: ["platform", "payments"] });
    await qc.invalidateQueries({ queryKey: ["billing"] });
  };

  const approveRequest = async (row: ActivationRequestListRow) => {
    const planCode = String(row.businesses?.plan_type || row.requested_plan_code || "").trim();
    const plan = planMap.get(planCode);
    const defaultMonths = Math.max(1, Math.min(24, Number(row.months_requested || 1) || 1));
    const monthsRaw = window.prompt("Approve for how many months?", String(defaultMonths));
    if (monthsRaw == null) return;
    const months = Math.max(1, Math.min(24, Number(monthsRaw) || defaultMonths));

    const suggestedAmount =
      row.requested_amount && Number(row.requested_amount) > 0
        ? Number(row.requested_amount)
        : (plan?.monthly_fee || 0) * months;
    const amountRaw = window.prompt(
      "Approved amount in USD (leave blank to auto-calculate on server)",
      suggestedAmount > 0 ? String(suggestedAmount) : ""
    );
    if (amountRaw == null) return;
    const note = window.prompt("Optional admin note", "") ?? "";

    let amount: number | null = null;
    if (String(amountRaw).trim()) {
      const n = Number(amountRaw);
      if (!Number.isFinite(n) || n < 0) return toast.error("Invalid amount");
      amount = n;
    }

    try {
      if (!(await requirePlatformCloudSession())) return;
      const { error } = await supabase.rpc("approve_activation_request", {
        p_request_id: row.id,
        p_months: months,
        p_amount: amount,
        p_kind: "manual",
        p_admin_note: String(note || "").trim() || null,
      });
      if (error) throw error;
      toast.success("Activation approved");
      await refresh();
    } catch (e: any) {
      toast.error(friendlyAdminError(e) || "Failed to approve activation");
    }
  };

  const rejectRequest = async (row: ActivationRequestListRow) => {
    const note = window.prompt("Reason for rejection (optional)", "") ?? "";
    try {
      if (!(await requirePlatformCloudSession())) return;
      const { error } = await supabase.rpc("reject_activation_request", {
        p_request_id: row.id,
        p_admin_note: String(note || "").trim() || null,
      });
      if (error) throw error;
      toast.success("Activation request rejected");
      await refresh();
    } catch (e: any) {
      toast.error(friendlyAdminError(e) || "Failed to reject request");
    }
  };

  const extendTrial = async (row: ActivationRequestListRow) => {
    const daysRaw = window.prompt("Extend trial by how many days?", "3");
    if (daysRaw == null) return;
    const days = Math.max(1, Math.min(60, Number(daysRaw) || 0));
    if (!days) return toast.error("Invalid number of days");
    const note = window.prompt("Optional note", "") ?? "";

    try {
      if (!(await requirePlatformCloudSession())) return;
      const { error } = await supabase.rpc("extend_business_trial", {
        p_business_id: row.business_id,
        p_days: days,
        p_note: String(note || "").trim() || null,
      });
      if (error) throw error;
      toast.success(`Trial extended by ${days} day(s)`);
      await refresh();
    } catch (e: any) {
      toast.error(friendlyAdminError(e) || "Failed to extend trial");
    }
  };

  const setLocked = async (row: ActivationRequestListRow, locked: boolean) => {
    const note = window.prompt(
      locked ? "Reason for lock (optional)" : "Reason for unlock (optional)",
      ""
    ) ?? "";
    try {
      if (!(await requirePlatformCloudSession())) return;
      const { error } = await supabase.rpc("set_business_lock", {
        p_business_id: row.business_id,
        p_locked: locked,
        p_note: String(note || "").trim() || null,
      });
      if (error) throw error;
      toast.success(locked ? "Business locked" : "Business unlocked");
      await refresh();
    } catch (e: any) {
      toast.error(friendlyAdminError(e) || "Failed to update lock state");
    }
  };

  return (
    <div className="p-4 md:p-6 space-y-4">
      <PlatformPageHeader
        title="Activation Requests"
        subtitle="Review manual payment submissions, approve/reject activations, extend trials, and lock/unlock businesses."
        right={<Button variant="outline" onClick={() => void refresh()}>Refresh</Button>}
      />

      <Card className="shadow-card">
        <CardHeader>
          <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-3">
            <CardTitle>Requests</CardTitle>
            <div className="flex flex-col sm:flex-row gap-2">
              <div className="flex items-center gap-2">
                <Label htmlFor="status-filter">Status</Label>
                <select
                  id="status-filter"
                  className="h-10 rounded-md border border-input bg-background px-3 text-sm"
                  value={statusFilter}
                  onChange={(e) =>
                    setStatusFilter(
                      e.target.value === "all" ? "all" : "pending"
                    )
                  }
                >
                  <option value="pending">Pending only</option>
                  <option value="all">All</option>
                </select>
              </div>
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search business / payer / ref"
                className="w-[260px] max-w-full"
              />
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="rounded-xl border border-border overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>Business</TableHead>
                  <TableHead>Payment</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Business State</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {!filteredRequests.length ? (
                  <TableRow>
                    <TableCell colSpan={6} className="text-sm text-muted-foreground">
                      {isFetching ? "Loading..." : "No activation requests found"}
                    </TableCell>
                  </TableRow>
                ) : (
                  filteredRequests.map((r) => {
                    const health = healthMap.get(r.business_id);
                    const planCode = String(r.businesses?.plan_type || r.requested_plan_code || "").trim();
                    const plan = planMap.get(planCode);
                    return (
                      <TableRow key={r.id}>
                        <TableCell className="text-sm">
                          <div>{new Date(r.created_at).toLocaleString()}</div>
                          <div className="text-xs text-muted-foreground">
                            {r.payment_method || "manual"}
                          </div>
                        </TableCell>
                        <TableCell className="text-sm">
                          <div className="font-semibold">
                            {r.businesses?.name || r.business_id}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            Plan: {plan?.display_name || planCode || "—"}
                          </div>
                          {r.message ? (
                            <div className="text-xs text-muted-foreground line-clamp-2">
                              {r.message}
                            </div>
                          ) : null}
                        </TableCell>
                        <TableCell className="text-sm">
                          <div>
                            {r.requested_amount != null ? `$${fmtMoney(r.requested_amount)}` : "—"}
                            {" • "}
                            {r.months_requested || 1} month(s)
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {r.payer_name || "—"} {r.payer_phone ? `• ${r.payer_phone}` : ""}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            Ref: {r.payment_reference || "—"}
                          </div>
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant={
                              r.status === "approved"
                                ? "secondary"
                                : r.status === "pending"
                                  ? "outline"
                                  : "destructive"
                            }
                          >
                            {r.status}
                          </Badge>
                          {r.admin_note ? (
                            <div className="text-xs text-muted-foreground mt-1 line-clamp-2">
                              {r.admin_note}
                            </div>
                          ) : null}
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant={
                              health?.access_state === "locked"
                                ? "destructive"
                                : health?.access_state === "grace"
                                  ? "outline"
                                  : "secondary"
                            }
                          >
                            {health?.access_state || "—"}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex flex-wrap justify-end gap-2">
                            <Button
                              size="sm"
                              onClick={() => void approveRequest(r)}
                              disabled={r.status !== "pending"}
                            >
                              Approve
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => void rejectRequest(r)}
                              disabled={r.status !== "pending"}
                            >
                              Reject
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => void extendTrial(r)}
                            >
                              Extend Trial
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => void setLocked(r, true)}
                            >
                              Lock
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => void setLocked(r, false)}
                            >
                              Unlock
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export default PlatformActivationRequestsPage;
