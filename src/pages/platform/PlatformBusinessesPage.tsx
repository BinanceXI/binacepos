import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { supabase } from "@/lib/supabase";
import {
  clampMoney,
  computeBusinessLicenseState,
  fmtMoney,
  normalizeCommercialPlanRow,
  sortPlans,
  toNum,
  type CommercialPlanRow,
} from "@/lib/commercialization";
import {
  friendlyAdminError,
  requirePlatformCloudSession,
  sanitizeUsername,
} from "@/lib/platformAdminUtils";
import { usePOS } from "@/contexts/POSContext";

import { PlatformPageHeader } from "@/components/platform/PlatformPageHeader";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

type BillingLite = {
  max_devices: number | null;
  paid_through: string | null;
  grace_days: number | null;
  locked_override: boolean | null;
  trial_started_at: string | null;
  trial_ends_at: string | null;
  activated_at: string | null;
};

type BusinessRow = {
  id: string;
  name: string;
  status: string;
  plan_type: string | null;
  created_at: string;
  deleted_at?: string | null;
  deleted_reason?: string | null;
  business_billing?: BillingLite | BillingLite[] | null;
};

type DeviceCountRow = {
  business_id: string;
  device_type: string | null;
  active: boolean;
};

type UserRow = {
  id: string;
  username: string | null;
  full_name: string | null;
  role: string;
  active: boolean | null;
};

type DeviceRow = {
  id: string;
  device_id: string;
  platform: string | null;
  device_type: string | null;
  device_label: string | null;
  active: boolean;
  last_seen_at: string | null;
};

function oneBilling(v: BusinessRow["business_billing"]): BillingLite | null {
  if (!v) return null;
  if (Array.isArray(v)) return (v[0] as BillingLite) || null;
  return v as BillingLite;
}

export function PlatformBusinessesPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { currentUser } = usePOS();

  const [tenantSearch, setTenantSearch] = useState("");
  const [selectedBusinessId, setSelectedBusinessId] = useState<string | null>(null);

  const [newBusinessName, setNewBusinessName] = useState("");
  const [newBusinessPlanCode, setNewBusinessPlanCode] = useState("starter");

  const [editPlanCode, setEditPlanCode] = useState("");
  const [editMaxDevices, setEditMaxDevices] = useState("");
  const [softDeleteReason, setSoftDeleteReason] = useState("");

  const [newAdminFullName, setNewAdminFullName] = useState("");
  const [newAdminUsername, setNewAdminUsername] = useState("");
  const [newAdminPassword, setNewAdminPassword] = useState("");

  const { data: plans = [] } = useQuery({
    queryKey: ["platform", "commercialPlans", "businessesPage"],
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

  const activePlans = useMemo(() => plans.filter((p) => p.active), [plans]);
  const planMap = useMemo(() => {
    const m = new Map<string, CommercialPlanRow>();
    for (const p of plans) m.set(p.plan_type, p);
    return m;
  }, [plans]);

  useEffect(() => {
    if (!activePlans.length) return;
    if (!activePlans.some((p) => p.plan_type === newBusinessPlanCode)) {
      setNewBusinessPlanCode(activePlans[0].plan_type);
    }
  }, [activePlans, newBusinessPlanCode]);

  const { data: businesses = [], isFetching: isFetchingBusinesses } = useQuery({
    queryKey: ["platform", "businesses", "commercial"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("businesses")
        .select(
          "id, name, status, plan_type, created_at, deleted_at, deleted_reason, business_billing(max_devices, paid_through, grace_days, locked_override, trial_started_at, trial_ends_at, activated_at)"
        )
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data || []) as unknown as BusinessRow[];
    },
    staleTime: 10_000,
    refetchOnWindowFocus: false,
  });

  const { data: allDevices = [] } = useQuery({
    queryKey: ["platform", "businesses", "deviceCounts"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("business_devices")
        .select("business_id, device_type, active")
        .limit(5000);
      if (error) throw error;
      return (data || []) as unknown as DeviceCountRow[];
    },
    staleTime: 10_000,
    refetchOnWindowFocus: false,
  });

  const deviceCountsByBusiness = useMemo(() => {
    const m = new Map<string, number>();
    for (const d of allDevices) {
      if (!d.active) continue;
      m.set(d.business_id, (m.get(d.business_id) || 0) + 1);
    }
    return m;
  }, [allDevices]);

  const enrichedBusinesses = useMemo(() => {
    const nowMs = Date.now();
    return businesses.map((b) => {
      const billing = oneBilling(b.business_billing);
      const state = computeBusinessLicenseState(b.status, billing, nowMs);
      const activeDevices = deviceCountsByBusiness.get(b.id) || 0;
      const planCode = String(b.plan_type || "starter").trim() || "starter";
      return {
        ...b,
        _billing: billing,
        _planCode: planCode,
        _licenseState: state,
        _activeDevices: activeDevices,
      };
    });
  }, [businesses, deviceCountsByBusiness]);

  const filteredBusinesses = useMemo(() => {
    const q = tenantSearch.trim().toLowerCase();
    if (!q) return enrichedBusinesses;
    return enrichedBusinesses.filter((b) => {
      return (
        String(b.name || "").toLowerCase().includes(q) ||
        String(b.id || "").toLowerCase().includes(q) ||
        String(b._planCode || "").toLowerCase().includes(q)
      );
    });
  }, [enrichedBusinesses, tenantSearch]);

  const selected = useMemo(
    () => enrichedBusinesses.find((b) => b.id === selectedBusinessId) || null,
    [enrichedBusinesses, selectedBusinessId]
  );

  useEffect(() => {
    if (!selected) {
      setEditPlanCode("");
      setEditMaxDevices("");
      return;
    }
    setEditPlanCode(selected._planCode);
    const max = Math.max(1, Math.min(50, Number(selected._billing?.max_devices ?? 2) || 2));
    setEditMaxDevices(String(max));
  }, [selected?.id, selected?._planCode, selected?._billing?.max_devices]);

  const { data: selectedUsers = [] } = useQuery({
    queryKey: ["platform", "businessUsers", selectedBusinessId],
    queryFn: async () => {
      if (!selectedBusinessId) return [] as UserRow[];
      const { data, error } = await supabase
        .from("profiles")
        .select("id, username, full_name, role, active")
        .eq("business_id", selectedBusinessId)
        .order("role")
        .order("full_name");
      if (error) throw error;
      return (data || []) as unknown as UserRow[];
    },
    enabled: !!selectedBusinessId,
    staleTime: 10_000,
    refetchOnWindowFocus: false,
  });

  const { data: selectedDevices = [] } = useQuery({
    queryKey: ["platform", "businessDevices", selectedBusinessId],
    queryFn: async () => {
      if (!selectedBusinessId) return [] as DeviceRow[];
      const { data, error } = await supabase
        .from("business_devices")
        .select("id, device_id, platform, device_type, device_label, active, last_seen_at")
        .eq("business_id", selectedBusinessId)
        .order("active", { ascending: false })
        .order("last_seen_at", { ascending: false });
      if (error) throw error;
      return (data || []) as unknown as DeviceRow[];
    },
    enabled: !!selectedBusinessId,
    staleTime: 10_000,
    refetchOnWindowFocus: false,
  });

  const { data: selectedRequests = [] } = useQuery({
    queryKey: ["platform", "activationRequests", "business", selectedBusinessId],
    queryFn: async () => {
      if (!selectedBusinessId) return [] as any[];
      try {
        const { data, error } = await supabase
          .from("activation_requests")
          .select("id, status, created_at, reviewed_at, admin_note")
          .eq("business_id", selectedBusinessId)
          .order("created_at", { ascending: false })
          .limit(10);
        if (error) throw error;
        return (data || []) as any[];
      } catch {
        return [] as any[];
      }
    },
    enabled: !!selectedBusinessId,
    staleTime: 10_000,
    refetchOnWindowFocus: false,
  });

  const refreshBusinesses = async () => {
    await qc.invalidateQueries({ queryKey: ["platform", "businesses"] });
    await qc.invalidateQueries({ queryKey: ["platform", "businessUsers"] });
    await qc.invalidateQueries({ queryKey: ["platform", "businessDevices"] });
    await qc.invalidateQueries({ queryKey: ["platform", "activationRequests"] });
    await qc.invalidateQueries({ queryKey: ["platform", "devices"] });
    await qc.invalidateQueries({ queryKey: ["platform", "users"] });
    await qc.invalidateQueries({ queryKey: ["platform", "commercialMetrics"] });
  };

  const createBusiness = async () => {
    const name = String(newBusinessName || "").trim();
    const planCode = String(newBusinessPlanCode || "").trim();
    if (!name) return toast.error("Business name required");
    if (!planCode) return toast.error("Select a plan");

    const plan = planMap.get(planCode);
    try {
      if (!(await requirePlatformCloudSession())) return;
      const { data, error } = await supabase
        .from("businesses")
        .insert({ name, status: "active", plan_type: planCode } as any)
        .select("id, name")
        .single();
      if (error) throw error;

      if (data?.id) {
        await supabase
          .from("business_billing")
          .update({
            max_devices: Math.max(1, Math.min(50, Number(plan?.device_limit || 2))),
            locked_override: false,
          } as any)
          .eq("business_id", data.id);
      }

      toast.success(`Created ${data?.name || "business"}`);
      setNewBusinessName("");
      await refreshBusinesses();
      if (data?.id) setSelectedBusinessId(String(data.id));
    } catch (e: any) {
      toast.error(friendlyAdminError(e) || "Failed to create business");
    }
  };

  const saveBusinessPlanAndLimits = async () => {
    if (!selected) return toast.error("Select a business");
    const planCode = String(editPlanCode || "").trim();
    if (!planCode) return toast.error("Select a plan");
    const maxDevices = Math.max(1, Math.min(50, Number(editMaxDevices) || 0));
    if (!maxDevices) return toast.error("Enter a valid device limit");

    try {
      if (!(await requirePlatformCloudSession())) return;
      const { error: bizErr } = await supabase
        .from("businesses")
        .update({ plan_type: planCode } as any)
        .eq("id", selected.id);
      if (bizErr) throw bizErr;

      const { error: billErr } = await supabase
        .from("business_billing")
        .update({ max_devices: maxDevices } as any)
        .eq("business_id", selected.id);
      if (billErr) throw billErr;

      toast.success("Business plan and device limit updated");
      await refreshBusinesses();
    } catch (e: any) {
      toast.error(friendlyAdminError(e) || "Failed to save business plan");
    }
  };

  const extendTrial = async () => {
    if (!selected) return toast.error("Select a business");
    const daysRaw = window.prompt("Extend trial by how many days?", "3");
    if (daysRaw == null) return;
    const days = Math.max(1, Math.min(60, Number(daysRaw) || 0));
    if (!days) return toast.error("Invalid days");
    try {
      if (!(await requirePlatformCloudSession())) return;
      const { error } = await supabase.rpc("extend_business_trial", {
        p_business_id: selected.id,
        p_days: days,
        p_note: null,
      });
      if (error) throw error;
      toast.success(`Trial extended by ${days} day(s)`);
      await refreshBusinesses();
    } catch (e: any) {
      toast.error(friendlyAdminError(e) || "Failed to extend trial");
    }
  };

  const setLock = async (locked: boolean) => {
    if (!selected) return toast.error("Select a business");
    const ok = window.confirm(
      locked
        ? `Lock "${selected.name}"? POS will remain blocked until unlocked.`
        : `Unlock "${selected.name}"? Access will resume after the next status check/restart if billing/trial is valid.`
    );
    if (!ok) return;
    try {
      if (!(await requirePlatformCloudSession())) return;
      const { error } = await supabase.rpc("set_business_lock", {
        p_business_id: selected.id,
        p_locked: locked,
        p_note: null,
      });
      if (error) throw error;
      toast.success(locked ? "Business locked" : "Business unlocked");
      await refreshBusinesses();
    } catch (e: any) {
      toast.error(friendlyAdminError(e) || "Failed to update business lock");
    }
  };

  const softDeleteBusiness = async () => {
    if (!selected) return toast.error("Select a business");
    const reason = String(softDeleteReason || "").trim();
    if (!reason) return toast.error("Enter a reason");
    const ok = window.confirm(
      `Soft delete "${selected.name}"?\n\nThis suspends access and disables users/devices.`
    );
    if (!ok) return;
    try {
      if (!(await requirePlatformCloudSession())) return;
      const { error } = await supabase.rpc("soft_delete_business", {
        p_business_id: selected.id,
        p_reason: reason,
      });
      if (error) throw error;
      toast.success("Business soft deleted");
      setSoftDeleteReason("");
      await refreshBusinesses();
    } catch (e: any) {
      toast.error(friendlyAdminError(e) || "Soft delete failed");
    }
  };

  const restoreBusiness = async () => {
    if (!selected) return toast.error("Select a business");
    const ok = window.confirm(`Restore "${selected.name}"?`);
    if (!ok) return;
    try {
      if (!(await requirePlatformCloudSession())) return;
      const { error } = await supabase.rpc("restore_business", {
        p_business_id: selected.id,
      });
      if (error) throw error;
      toast.success("Business restored");
      await refreshBusinesses();
    } catch (e: any) {
      toast.error(friendlyAdminError(e) || "Restore failed");
    }
  };

  const createBusinessAdmin = async () => {
    if (!selected) return toast.error("Select a business");

    const full_name = String(newAdminFullName || "").trim();
    const username = sanitizeUsername(newAdminUsername);
    const password = String(newAdminPassword || "");
    if (!full_name) return toast.error("Full name required");
    if (!username || username.length < 3)
      return toast.error("Username must be 3+ characters");
    if (password.length < 6) return toast.error("Password must be at least 6 characters");

    try {
      if (!(await requirePlatformCloudSession())) return;
      const { data, error } = await supabase.functions.invoke("create_staff_user", {
        body: {
          business_id: selected.id,
          username,
          password,
          full_name,
          role: "admin",
          permissions: {
            allowRefunds: true,
            allowVoid: true,
            allowPriceEdit: true,
            allowDiscount: true,
            allowReports: true,
            allowInventory: true,
            allowSettings: true,
            allowEditReceipt: true,
          },
        },
      });
      if (error) throw error;
      if ((data as any)?.error) throw new Error((data as any).error);
      toast.success(`Created admin @${username}`);
      setNewAdminFullName("");
      setNewAdminUsername("");
      setNewAdminPassword("");
      await qc.invalidateQueries({ queryKey: ["platform", "businessUsers", selected.id] });
    } catch (e: any) {
      toast.error(friendlyAdminError(e) || "Failed to create business admin");
    }
  };

  const setUserActive = async (userId: string, nextActive: boolean) => {
    if (!selected) return;
    if (String(currentUser?.id || "") === userId) {
      return toast.error("You cannot modify your own account here");
    }
    try {
      if (!(await requirePlatformCloudSession())) return;
      const { error } = await supabase
        .from("profiles")
        .update({ active: nextActive } as any)
        .eq("id", userId);
      if (error) throw error;
      toast.success(nextActive ? "User activated" : "User deactivated");
      await qc.invalidateQueries({ queryKey: ["platform", "businessUsers", selected.id] });
      await qc.invalidateQueries({ queryKey: ["platform", "users"] });
    } catch (e: any) {
      toast.error(friendlyAdminError(e) || "Failed to update user");
    }
  };

  const deleteUser = async (userId: string) => {
    if (!selected) return;
    if (String(currentUser?.id || "") === userId) {
      return toast.error("You cannot delete your own account");
    }
    const ok = window.confirm(
      "Permanently delete this user?\n\nIf linked history exists, deletion may fail and you should deactivate instead."
    );
    if (!ok) return;
    try {
      if (!(await requirePlatformCloudSession())) return;
      const { data, error } = await supabase.functions.invoke("delete_staff_user", {
        body: { user_id: userId },
      });
      if (error) throw error;
      if ((data as any)?.error) throw new Error((data as any).error);
      toast.success("User deleted");
      await qc.invalidateQueries({ queryKey: ["platform", "businessUsers", selected.id] });
      await qc.invalidateQueries({ queryKey: ["platform", "users"] });
    } catch (e: any) {
      toast.error(friendlyAdminError(e) || "Delete failed");
    }
  };

  const toggleDeviceActive = async (device: DeviceRow, nextActive: boolean) => {
    if (!selected) return;
    try {
      if (!(await requirePlatformCloudSession())) return;
      const { error } = await supabase
        .from("business_devices")
        .update({ active: nextActive } as any)
        .eq("id", device.id);
      if (error) throw error;
      toast.success(nextActive ? "Device activated" : "Device deactivated");
      await qc.invalidateQueries({ queryKey: ["platform", "businessDevices", selected.id] });
      await qc.invalidateQueries({ queryKey: ["platform", "devices"] });
      await refreshBusinesses();
    } catch (e: any) {
      toast.error(friendlyAdminError(e) || "Failed to update device");
    }
  };

  const selectedPlan = selected ? planMap.get(selected._planCode) : null;
  const selectedBilling = selected?._billing || null;

  return (
    <div className="p-4 md:p-6 space-y-4">
      <PlatformPageHeader
        title="Businesses"
        subtitle="Create and manage businesses, licensing, plans, device limits, users, and devices."
        right={
          <Button variant="outline" onClick={() => void refreshBusinesses()}>
            Refresh
          </Button>
        }
      />

      <Card className="shadow-card">
        <CardHeader>
          <CardTitle>Create Business</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-4 gap-3 md:items-end">
          <div className="md:col-span-2 space-y-2">
            <Label>Business Name</Label>
            <Input
              value={newBusinessName}
              onChange={(e) => setNewBusinessName(e.target.value)}
              placeholder="Tengelele Store"
            />
          </div>
          <div className="space-y-2">
            <Label>Plan</Label>
            <select
              className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
              value={newBusinessPlanCode}
              onChange={(e) => setNewBusinessPlanCode(e.target.value)}
            >
              {activePlans.map((p) => (
                <option key={p.plan_type} value={p.plan_type}>
                  {p.display_name} ({p.device_limit} devices)
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-2">
            <Label>Pricing Preview</Label>
            <div className="rounded-md border border-border px-3 py-2 text-sm">
              {(() => {
                const p = planMap.get(newBusinessPlanCode);
                if (!p) return "—";
                return `$${fmtMoney(p.setup_fee)} setup • $${fmtMoney(p.monthly_fee)}/month`;
              })()}
            </div>
          </div>
          <div className="md:col-span-4 flex justify-end">
            <Button onClick={createBusiness}>Create Business</Button>
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card className="lg:col-span-2 shadow-card">
          <CardHeader>
            <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-2">
              <CardTitle>Businesses</CardTitle>
              <Input
                value={tenantSearch}
                onChange={(e) => setTenantSearch(e.target.value)}
                placeholder="Search name / id / plan"
                className="w-[260px] max-w-full"
              />
            </div>
          </CardHeader>
          <CardContent>
            <div className="rounded-xl border border-border overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Plan</TableHead>
                    <TableHead>Devices</TableHead>
                    <TableHead>License</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {!filteredBusinesses.length ? (
                    <TableRow>
                      <TableCell colSpan={5} className="text-sm text-muted-foreground">
                        {isFetchingBusinesses ? "Loading..." : "No businesses found"}
                      </TableCell>
                    </TableRow>
                  ) : (
                    filteredBusinesses.map((b) => {
                      const isSelected = selectedBusinessId === b.id;
                      const maxDevices = Math.max(
                        1,
                        Math.min(50, Number(b._billing?.max_devices ?? 2) || 2)
                      );
                      return (
                        <TableRow
                          key={b.id}
                          className={isSelected ? "bg-primary/6" : ""}
                          style={{ cursor: "pointer" }}
                          onClick={() => setSelectedBusinessId(b.id)}
                        >
                          <TableCell className="text-sm">
                            <div className="font-semibold">{b.name}</div>
                            <div className="text-xs text-muted-foreground">{b.id}</div>
                          </TableCell>
                          <TableCell>
                            <Badge variant="outline">
                              {planMap.get(b._planCode)?.display_name || b._planCode}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-sm">
                            {b._activeDevices}/{maxDevices}
                          </TableCell>
                          <TableCell>
                            <Badge
                              variant={
                                b._licenseState === "locked"
                                  ? "destructive"
                                  : b._licenseState === "trial" || b._licenseState === "grace"
                                    ? "outline"
                                    : "secondary"
                              }
                            >
                              {b._licenseState}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            <Badge variant={b.status === "active" ? "secondary" : "destructive"}>
                              {b.status}
                            </Badge>
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

        <Card className="shadow-card">
          <CardHeader>
            <CardTitle>Selected Business</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {!selected ? (
              <div className="text-sm text-muted-foreground">
                Select a business to manage plan, licensing, users, and devices.
              </div>
            ) : (
              <>
                <div className="space-y-1">
                  <div className="text-sm font-semibold">{selected.name}</div>
                  <div className="text-xs text-muted-foreground">{selected.id}</div>
                </div>

                <div className="rounded-xl border border-border bg-card/50 px-3 py-3 space-y-3">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <div className="space-y-2">
                      <Label>Plan</Label>
                      <select
                        className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                        value={editPlanCode}
                        onChange={(e) => {
                          const next = e.target.value;
                          setEditPlanCode(next);
                          const p = planMap.get(next);
                          if (p) setEditMaxDevices(String(p.device_limit));
                        }}
                      >
                        {plans.map((p) => (
                          <option key={p.plan_type} value={p.plan_type}>
                            {p.display_name} {p.active ? "" : "(disabled)"} - {p.device_limit} devices
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="space-y-2">
                      <Label>Device limit</Label>
                      <Input
                        value={editMaxDevices}
                        onChange={(e) => setEditMaxDevices(e.target.value)}
                        inputMode="numeric"
                      />
                    </div>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {selectedPlan ? (
                      <>
                        Plan pricing: ${fmtMoney(selectedPlan.setup_fee)} setup • $
                        {fmtMoney(selectedPlan.monthly_fee)}/month
                      </>
                    ) : (
                      "Plan pricing unavailable"
                    )}
                  </div>
                  <Button variant="outline" className="w-full" onClick={saveBusinessPlanAndLimits}>
                    Save Plan & Device Limit
                  </Button>
                </div>

                <div className="rounded-xl border border-border bg-card/50 px-3 py-3 space-y-3">
                  <div className="text-sm font-semibold">License & Trial</div>
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <div className="rounded-lg border border-border px-2 py-2">
                      <div className="text-muted-foreground">State</div>
                      <div className="font-semibold">{selected._licenseState}</div>
                    </div>
                    <div className="rounded-lg border border-border px-2 py-2">
                      <div className="text-muted-foreground">Locked Override</div>
                      <div className="font-semibold">
                        {selectedBilling?.locked_override ? "Yes" : "No"}
                      </div>
                    </div>
                    <div className="rounded-lg border border-border px-2 py-2">
                      <div className="text-muted-foreground">Trial Ends</div>
                      <div className="font-semibold">
                        {selectedBilling?.trial_ends_at
                          ? new Date(selectedBilling.trial_ends_at).toLocaleDateString()
                          : "—"}
                      </div>
                    </div>
                    <div className="rounded-lg border border-border px-2 py-2">
                      <div className="text-muted-foreground">Paid Through</div>
                      <div className="font-semibold">
                        {selectedBilling?.paid_through
                          ? new Date(selectedBilling.paid_through).toLocaleDateString()
                          : "—"}
                      </div>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" variant="outline" onClick={extendTrial}>
                      Extend Trial
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => void setLock(true)}>
                      Lock
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => void setLock(false)}>
                      Unlock
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => navigate("/platform/activation-requests")}
                    >
                      Activation Requests
                    </Button>
                  </div>
                </div>

                <div className="rounded-xl border border-border bg-card/50 px-3 py-3 space-y-3">
                  <div className="text-sm font-semibold">Business Lifecycle</div>
                  <div className="space-y-2">
                    <Label>Soft delete reason</Label>
                    <Input
                      value={softDeleteReason}
                      onChange={(e) => setSoftDeleteReason(e.target.value)}
                      placeholder="Cancellation / abuse / requested closure / etc."
                    />
                  </div>
                  <div className="flex gap-2">
                    <Button
                      variant="destructive"
                      className="flex-1"
                      onClick={softDeleteBusiness}
                    >
                      Soft Delete
                    </Button>
                    <Button variant="outline" className="flex-1" onClick={restoreBusiness}>
                      Restore
                    </Button>
                  </div>
                  <div className="text-[11px] text-muted-foreground">
                    Soft delete is reversible and suspends business access while preserving records.
                  </div>
                </div>

                <div className="pt-2 border-t border-border/70 space-y-3">
                  <div className="text-sm font-semibold">Create Business Admin</div>
                  <div className="space-y-2">
                    <Label>Full name</Label>
                    <Input value={newAdminFullName} onChange={(e) => setNewAdminFullName(e.target.value)} />
                  </div>
                  <div className="space-y-2">
                    <Label>Username</Label>
                    <Input
                      value={newAdminUsername}
                      onChange={(e) => setNewAdminUsername(e.target.value)}
                      autoCapitalize="none"
                      autoCorrect="off"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Password</Label>
                    <Input
                      type="password"
                      value={newAdminPassword}
                      onChange={(e) => setNewAdminPassword(e.target.value)}
                    />
                  </div>
                  <Button onClick={createBusinessAdmin}>Create Admin</Button>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </div>

      {selected ? (
        <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
          <Card className="shadow-card">
            <CardHeader>
              <CardTitle>Users ({selectedUsers.length})</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-2 max-h-[420px] overflow-auto pos-scrollbar pr-1">
                {!selectedUsers.length ? (
                  <div className="text-sm text-muted-foreground">No users found.</div>
                ) : (
                  selectedUsers.map((u) => (
                    <div key={u.id} className="rounded-xl border border-border px-3 py-2 space-y-2">
                      <div className="flex items-center justify-between gap-2">
                        <div className="min-w-0">
                          <div className="text-sm font-semibold truncate">
                            {u.full_name || u.username || "—"}
                          </div>
                          <div className="text-xs text-muted-foreground truncate">
                            {u.username || "—"} • {u.role}
                          </div>
                        </div>
                        <Badge variant={u.active === false ? "destructive" : "secondary"}>
                          {u.active === false ? "disabled" : "active"}
                        </Badge>
                      </div>
                      <div className="flex gap-2">
                        <Button size="sm" variant="outline" className="flex-1" onClick={() => void setUserActive(u.id, true)}>
                          Activate
                        </Button>
                        <Button size="sm" variant="outline" className="flex-1" onClick={() => void setUserActive(u.id, false)}>
                          Deactivate
                        </Button>
                        <Button size="sm" variant="destructive" className="flex-1" onClick={() => void deleteUser(u.id)}>
                          Delete
                        </Button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </CardContent>
          </Card>

          <Card className="shadow-card">
            <CardHeader>
              <CardTitle>
                Devices ({selectedDevices.filter((d) => d.active).length}/
                {Math.max(1, Math.min(50, Number(selectedBilling?.max_devices ?? 2) || 2))})
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-2 max-h-[420px] overflow-auto pos-scrollbar pr-1">
                {!selectedDevices.length ? (
                  <div className="text-sm text-muted-foreground">No devices registered.</div>
                ) : (
                  selectedDevices.map((d) => (
                    <div key={d.id} className="rounded-xl border border-border px-3 py-2 space-y-2">
                      <div className="flex items-center justify-between gap-2">
                        <div className="min-w-0">
                          <div className="text-sm font-semibold truncate">
                            {d.device_label || d.platform || "device"}
                          </div>
                          <div className="text-xs text-muted-foreground truncate">
                            {d.device_type || "unknown"} • {d.device_id}
                          </div>
                          <div className="text-xs text-muted-foreground truncate">
                            Last seen: {d.last_seen_at ? new Date(d.last_seen_at).toLocaleString() : "—"}
                          </div>
                        </div>
                        <Badge variant={d.active ? "secondary" : "destructive"}>
                          {d.active ? "active" : "inactive"}
                        </Badge>
                      </div>
                      <Button
                        size="sm"
                        variant={d.active ? "outline" : "default"}
                        onClick={() => void toggleDeviceActive(d, !d.active)}
                      >
                        {d.active ? "Deactivate" : "Activate"}
                      </Button>
                    </div>
                  ))
                )}
              </div>
            </CardContent>
          </Card>

          <Card className="shadow-card">
            <CardHeader>
              <CardTitle>Activation Requests ({selectedRequests.length})</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-2 max-h-[420px] overflow-auto pos-scrollbar pr-1">
                {!selectedRequests.length ? (
                  <div className="text-sm text-muted-foreground">No activation requests yet.</div>
                ) : (
                  selectedRequests.map((r: any) => (
                    <div key={r.id} className="rounded-xl border border-border px-3 py-2">
                      <div className="flex items-center justify-between gap-2">
                        <div className="text-sm font-semibold">
                          {new Date(r.created_at).toLocaleString()}
                        </div>
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
                      </div>
                      {r.admin_note ? (
                        <div className="text-xs text-muted-foreground mt-1 line-clamp-2">
                          {r.admin_note}
                        </div>
                      ) : null}
                    </div>
                  ))
                )}
              </div>
              <Button
                className="w-full mt-3"
                variant="outline"
                onClick={() => navigate("/platform/activation-requests")}
              >
                Open Activation Requests
              </Button>
            </CardContent>
          </Card>
        </div>
      ) : null}
    </div>
  );
}

export default PlatformBusinessesPage;
