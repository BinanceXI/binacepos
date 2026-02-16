import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/lib/supabase";
import { BRAND } from "@/lib/brand";
import { ensureSupabaseSession } from "@/lib/supabaseSession";
import { computePlanPricing, type PlanType } from "@/lib/pricing";
import { secureTime } from "@/lib/secureTime";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { usePOS } from "@/contexts/POSContext";

type BusinessRow = {
  id: string;
  name: string;
  status: "active" | "suspended" | string;
  plan_type?: "business_system" | "app_only" | string | null;
  created_at: string;
  business_billing?: {
    paid_through: string;
    grace_days: number;
    locked_override: boolean;
    currency: string;
    max_devices?: number;
  } | null;
};

type DeviceRow = {
  id: string;
  device_id: string;
  platform: string;
  device_label: string | null;
  active: boolean;
  registered_at: string;
  last_seen_at: string;
};

type PaymentRow = {
  id: string;
  amount: number;
  currency: string;
  kind: "setup" | "subscription" | "reactivation" | "manual" | string;
  notes: string | null;
  created_at: string;
};

type ReactivationCodeRow = {
  id: string;
  code_prefix: string | null;
  months: number;
  issued_at: string;
  redeemed_at: string | null;
  active: boolean;
};

type ImpersonationAuditRow = {
  id: string;
  reason: string;
  created_at: string;
  ended_at: string | null;
  support_user_id: string;
  platform_admin_id: string;
};

function daysFromNow(d: Date, nowMs: number) {
  return Math.ceil((d.getTime() - nowMs) / (24 * 60 * 60 * 1000));
}

function computeAccessState(b: BusinessRow, nowMs: number) {
  const paid = b.business_billing?.paid_through ? new Date(b.business_billing.paid_through) : null;
  const graceDays = b.business_billing?.grace_days ?? 7;
  const overrideLocked = b.business_billing?.locked_override === true;

  if (b.status === "suspended" || overrideLocked) return "locked";
  if (!paid || Number.isNaN(paid.getTime())) return "locked";

  const graceEnd = new Date(paid.getTime() + graceDays * 24 * 60 * 60 * 1000);
  if (nowMs <= paid.getTime()) return "active";
  if (nowMs <= graceEnd.getTime()) return "grace";
  return "locked";
}

function sanitizeUsername(raw: string) {
  return String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "");
}

function friendlyAdminError(e: any) {
  const status = (e as any)?.status;
  const msg = String((e as any)?.message || "");

  // PostgREST often returns 404 for unauthorized RPCs.
  if (status === 404) return "Not authorized (cloud session missing). Sign out and sign in again while online.";
  if (status === 401) return "Cloud session missing. Sign out and sign in again while online.";
  if (status === 403) return "Access denied.";
  if (msg.toLowerCase().includes("missing or invalid user session")) {
    return "Cloud session missing. Sign out and sign in again while online.";
  }
  return msg || "Request failed";
}

export function PlatformAdminPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { setCurrentUser } = usePOS();

  const [newBusinessName, setNewBusinessName] = useState("");
  const [newBusinessPlan, setNewBusinessPlan] = useState<PlanType>("business_system");
  const [newBusinessMaxDevices, setNewBusinessMaxDevices] = useState("2");
  const [selectedBusinessId, setSelectedBusinessId] = useState<string | null>(null);

  const [paymentAmount, setPaymentAmount] = useState("15");
  const [paymentKind, setPaymentKind] = useState<"setup" | "subscription" | "reactivation" | "manual">("subscription");
  const [extendMonths, setExtendMonths] = useState("1");

  const [newAdminFullName, setNewAdminFullName] = useState("");
  const [newAdminUsername, setNewAdminUsername] = useState("");
  const [newAdminPassword, setNewAdminPassword] = useState("");

  const [impersonationReason, setImpersonationReason] = useState("");
  const [impersonationRole, setImpersonationRole] = useState<"admin" | "cashier">("admin");
  const [impersonating, setImpersonating] = useState(false);

  const [editMaxDevices, setEditMaxDevices] = useState<string>("");

  const { data: businesses = [], isFetching } = useQuery({
    queryKey: ["platform", "businesses"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("businesses")
        .select("id, name, status, plan_type, created_at, business_billing(paid_through, grace_days, locked_override, currency, max_devices)")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data || []) as BusinessRow[];
    },
    staleTime: 15_000,
    refetchOnWindowFocus: false,
  });

  const selected = useMemo(
    () => businesses.find((b) => b.id === selectedBusinessId) || null,
    [businesses, selectedBusinessId]
  );

  const selectedPlan: PlanType = selected?.plan_type === "app_only" ? "app_only" : "business_system";
  const selectedDeviceCap = selected?.business_billing?.max_devices ?? (selectedPlan === "app_only" ? 1 : 2);
  const selectedPricing = useMemo(
    () => computePlanPricing(selectedPlan, selectedDeviceCap),
    [selectedPlan, selectedDeviceCap]
  );

  const newBizDeviceCap = Math.max(1, Math.min(50, Number(newBusinessMaxDevices) || (newBusinessPlan === "app_only" ? 1 : 2)));
  const newBizPricing = useMemo(
    () => computePlanPricing(newBusinessPlan, newBizDeviceCap),
    [newBusinessPlan, newBizDeviceCap]
  );

  useEffect(() => {
    setNewBusinessMaxDevices(newBusinessPlan === "app_only" ? "1" : "2");
  }, [newBusinessPlan]);

  useEffect(() => {
    if (!selected) {
      setEditMaxDevices("");
      return;
    }

    const cap = selected.business_billing?.max_devices ?? (selectedPlan === "app_only" ? 1 : 2);
    setEditMaxDevices(String(cap));
  }, [selected, selected?.id, selected?.business_billing?.max_devices, selectedPlan]);

  useEffect(() => {
    if (!selected) return;
    if (paymentKind === "setup") setPaymentAmount(String(selectedPricing.setup));
    if (paymentKind === "subscription") setPaymentAmount(String(selectedPricing.monthly));
  }, [selected, selected?.id, paymentKind, selectedPricing.setup, selectedPricing.monthly]);

  const { data: selectedUsers = [] } = useQuery({
    queryKey: ["platform", "businessUsers", selectedBusinessId],
    queryFn: async () => {
      if (!selectedBusinessId) return [];
      const { data, error } = await supabase
        .from("profiles")
        .select("id, username, full_name, role, active")
        .eq("business_id", selectedBusinessId)
        .order("role")
        .order("full_name");
      if (error) throw error;
      return data || [];
    },
    enabled: !!selectedBusinessId,
    staleTime: 10_000,
    refetchOnWindowFocus: false,
  });

  const { data: selectedDevices = [] } = useQuery({
    queryKey: ["platform", "businessDevices", selectedBusinessId],
    queryFn: async () => {
      if (!selectedBusinessId) return [];
      const { data, error } = await supabase
        .from("business_devices")
        .select("id, device_id, platform, device_label, active, registered_at, last_seen_at")
        .eq("business_id", selectedBusinessId)
        .order("active", { ascending: false })
        .order("last_seen_at", { ascending: false });
      if (error) throw error;
      return (data || []) as DeviceRow[];
    },
    enabled: !!selectedBusinessId,
    staleTime: 10_000,
    refetchOnWindowFocus: false,
  });

  const { data: selectedPayments = [] } = useQuery({
    queryKey: ["platform", "businessPayments", selectedBusinessId],
    queryFn: async () => {
      if (!selectedBusinessId) return [];
      const { data, error } = await supabase
        .from("billing_payments")
        .select("id, amount, currency, kind, notes, created_at")
        .eq("business_id", selectedBusinessId)
        .order("created_at", { ascending: false })
        .limit(50);
      if (error) throw error;
      return (data || []) as unknown as PaymentRow[];
    },
    enabled: !!selectedBusinessId,
    staleTime: 10_000,
    refetchOnWindowFocus: false,
  });

  const { data: selectedCodes = [] } = useQuery({
    queryKey: ["platform", "businessCodes", selectedBusinessId],
    queryFn: async () => {
      if (!selectedBusinessId) return [];
      const { data, error } = await supabase
        .from("reactivation_codes")
        .select("id, code_prefix, months, issued_at, redeemed_at, active")
        .eq("business_id", selectedBusinessId)
        .order("issued_at", { ascending: false })
        .limit(50);
      if (error) throw error;
      return (data || []) as unknown as ReactivationCodeRow[];
    },
    enabled: !!selectedBusinessId,
    staleTime: 10_000,
    refetchOnWindowFocus: false,
  });

  const { data: selectedImpersonations = [] } = useQuery({
    queryKey: ["platform", "businessImpersonations", selectedBusinessId],
    queryFn: async () => {
      if (!selectedBusinessId) return [];
      const { data, error } = await supabase
        .from("impersonation_audit")
        .select("id, reason, created_at, ended_at, support_user_id, platform_admin_id")
        .eq("business_id", selectedBusinessId)
        .order("created_at", { ascending: false })
        .limit(20);
      if (error) throw error;
      return (data || []) as unknown as ImpersonationAuditRow[];
    },
    enabled: !!selectedBusinessId,
    staleTime: 10_000,
    refetchOnWindowFocus: false,
  });

  const requireCloudSession = async () => {
    const res = await ensureSupabaseSession();
    if (res.ok) return true;
    toast.error("Cloud session missing. Sign out and sign in again while online.");
    return false;
  };

  const createBusiness = async () => {
    const name = String(newBusinessName || "").trim();
    if (!name) return toast.error("Business name required");

    try {
      if (!(await requireCloudSession())) return;
      const plan_type: PlanType = newBusinessPlan === "app_only" ? "app_only" : "business_system";
      const max_devices = Math.max(1, Math.min(50, Number(newBusinessMaxDevices) || (plan_type === "app_only" ? 1 : 2)));

      const { data, error } = await supabase
        .from("businesses")
        .insert({ name, status: "active", plan_type })
        .select("id, name, status, plan_type, created_at")
        .single();
      if (error) throw error;

      // Ensure device cap is set explicitly (defaults are plan-based, but admin may override during onboarding).
      if (data?.id) {
        const { error: billErr } = await supabase.from("business_billing").update({ max_devices }).eq("business_id", data.id);
        if (billErr) throw billErr;
      }

      toast.success(`Created ${data?.name || "business"}`);
      setNewBusinessName("");
      await qc.invalidateQueries({ queryKey: ["platform", "businesses"] });
      if (data?.id) setSelectedBusinessId(String(data.id));
    } catch (e: any) {
      toast.error(friendlyAdminError(e) || "Failed to create business");
    }
  };

  const createBusinessAdmin = async () => {
    if (!selected) return toast.error("Select a business");

    const full_name = String(newAdminFullName || "").trim();
    const username = sanitizeUsername(newAdminUsername);
    const password = String(newAdminPassword || "");

    if (!full_name) return toast.error("Full name required");
    if (!username || username.length < 3) return toast.error("Username must be 3+ characters");
    if (password.length < 6) return toast.error("Password must be at least 6 characters");

    try {
      if (!(await requireCloudSession())) return;
      const adminPerms = {
        allowRefunds: true,
        allowVoid: true,
        allowPriceEdit: true,
        allowDiscount: true,
        allowReports: true,
        allowInventory: true,
        allowSettings: true,
        allowEditReceipt: true,
      };

      const { data: fnData, error: fnErr } = await supabase.functions.invoke("create_staff_user", {
        body: {
          business_id: selected.id,
          username,
          password,
          full_name,
          role: "admin",
          permissions: adminPerms,
        },
      });

      if (fnErr) throw fnErr;
      if ((fnData as any)?.error) throw new Error((fnData as any).error);

      toast.success(`Created admin @${username}`);
      setNewAdminFullName("");
      setNewAdminUsername("");
      setNewAdminPassword("");
      await qc.invalidateQueries({ queryKey: ["platform", "businessUsers", selected.id] });
    } catch (e: any) {
      toast.error(friendlyAdminError(e) || "Failed to create business admin");
    }
  };

  const toggleDeviceActive = async (device: DeviceRow, nextActive: boolean) => {
    if (!selected) return toast.error("Select a business");
    try {
      if (!(await requireCloudSession())) return;
      const { error } = await supabase.from("business_devices").update({ active: nextActive }).eq("id", device.id);
      if (error) throw error;
      toast.success(nextActive ? "Device reactivated" : "Device deactivated");
      await qc.invalidateQueries({ queryKey: ["platform", "businessDevices", selected.id] });
    } catch (e: any) {
      toast.error(friendlyAdminError(e) || "Failed to update device");
    }
  };

  const saveMaxDevicesForBusiness = async () => {
    if (!selected) return toast.error("Select a business");
    const next = Math.max(1, Math.min(50, Number(editMaxDevices) || 0));
    if (!Number.isFinite(next) || next <= 0) return toast.error("Enter a valid device limit");

    try {
      if (!(await requireCloudSession())) return;
      const { error } = await supabase
        .from("business_billing")
        .update({ max_devices: next })
        .eq("business_id", selected.id);
      if (error) throw error;

      toast.success("Updated device limit");
      await qc.invalidateQueries({ queryKey: ["platform", "businesses"] });
    } catch (e: any) {
      toast.error(friendlyAdminError(e) || "Failed to update device limit");
    }
  };

  const recordPaymentAndActivate = async () => {
    if (!selected) return toast.error("Select a business");

    const amount = Number(paymentAmount);
    const months = Math.max(0, Math.min(24, Number(extendMonths) || 0));
    if (!Number.isFinite(amount) || amount <= 0) return toast.error("Enter a valid amount");

    try {
      if (!(await requireCloudSession())) return;
      // 1) Record payment
      const currency = selected.business_billing?.currency || "USD";
      const { error: payErr } = await supabase.from("billing_payments").insert({
        business_id: selected.id,
        amount,
        currency,
        kind: paymentKind,
        notes: null,
      });
      if (payErr) throw payErr;

      // 2) Extend subscription
      if (months > 0) {
        const currentPaid = selected.business_billing?.paid_through ? new Date(selected.business_billing.paid_through) : new Date(0);
        const base = new Date(Math.max(Date.now(), currentPaid.getTime()));
        const next = new Date(base.getTime() + months * 30 * 24 * 60 * 60 * 1000);

        const { error: billErr } = await supabase
          .from("business_billing")
          .update({ paid_through: next.toISOString(), locked_override: false })
          .eq("business_id", selected.id);
        if (billErr) throw billErr;
      }

      toast.success(months > 0 ? `Activated for ${months} month(s)` : "Payment recorded");
      await qc.invalidateQueries({ queryKey: ["platform", "businesses"] });
    } catch (e: any) {
      toast.error(friendlyAdminError(e) || "Failed to activate");
    }
  };

  const generateReactivationCode = async () => {
    if (!selected) return toast.error("Select a business");
    const months = Math.max(1, Math.min(24, Number(extendMonths) || 1));

    try {
      if (!(await requireCloudSession())) return;
      const { data, error } = await supabase.rpc("issue_reactivation_code", {
        p_business_id: selected.id,
        p_months: months,
      });
      if (error) throw error;
      const code = String(data || "").trim();
      if (!code) throw new Error("No code returned");

      try {
        await navigator.clipboard.writeText(code);
        toast.success(`Code copied: ${code}`);
      } catch {
        toast.success(`Code: ${code}`);
      }
    } catch (e: any) {
      toast.error(friendlyAdminError(e) || "Failed to generate code");
    }
  };

  const startImpersonation = async () => {
    if (!selected) return toast.error("Select a business");
    if (!navigator.onLine) return toast.error("Impersonation requires an internet connection");

    const reason = String(impersonationReason || "").trim();
    if (reason.length < 3) return toast.error("Enter a short reason (3+ chars)");

    if (impersonating) return;
    setImpersonating(true);
    try {
      if (!(await requireCloudSession())) return;

      const session = (await supabase.auth.getSession()).data.session;
      if (!session?.access_token || !session?.refresh_token) {
        throw new Error("Cloud session missing. Sign out and sign in again while online.");
      }

      const { data: out, error: fnErr } = await supabase.functions.invoke("impersonate_business", {
        body: {
          business_id: selected.id,
          role: impersonationRole,
          reason,
        },
      });
      if (fnErr) throw fnErr;

      const token_hash = String((out as any)?.token_hash || "");
      const type = String((out as any)?.type || "magiclink");
      const audit_id = String((out as any)?.audit_id || "");
      if (!token_hash || !audit_id) throw new Error("Impersonation token missing");

      // Backup platform admin session so we can restore without re-entering password.
      localStorage.setItem(
        "platform_admin_session_backup_v1",
        JSON.stringify({
          access_token: session.access_token,
          refresh_token: session.refresh_token,
          saved_at: new Date().toISOString(),
        })
      );
      localStorage.setItem(
        "platform_admin_impersonation_v1",
        JSON.stringify({
          audit_id,
          business_id: selected.id,
          business_name: selected.name,
          role: impersonationRole,
          started_at: new Date().toISOString(),
        })
      );

      // Prevent cross-tenant stale data showing after the auth context switches.
      try {
        localStorage.removeItem("REACT_QUERY_OFFLINE_CACHE");
      } catch {
        // ignore
      }
      qc.clear();

      const { data: otp, error: otpErr } = await supabase.auth.verifyOtp({
        token_hash,
        // @ts-ignore supabase-js expects a specific union; we only ever return magiclink
        type,
      });
      if (otpErr) throw otpErr;
      if (!otp?.session?.access_token) throw new Error("Failed to mint support session");

      const { data: u, error: uErr } = await supabase.auth.getUser();
      if (uErr || !u?.user?.id) throw uErr || new Error("Failed to load support user");

      const { data: profile, error: pErr } = await supabase
        .from("profiles")
        .select("id, username, full_name, role, permissions, active, business_id, is_support")
        .eq("id", u.user.id)
        .maybeSingle();
      if (pErr || !profile) throw pErr || new Error("Failed to load support profile");
      if ((profile as any)?.active === false) throw new Error("Support account disabled");
      if ((profile as any)?.is_support !== true) throw new Error("Not a support account");

      setCurrentUser({
        id: String((profile as any).id),
        full_name: (profile as any).full_name || (profile as any).username,
        name: (profile as any).full_name || (profile as any).username,
        username: (profile as any).username,
        role: (profile as any).role || "admin",
        permissions: (profile as any).permissions || {},
        business_id: (profile as any).business_id ?? null,
        active: true,
      } as any);

      sessionStorage.setItem("binancexi_session_active", "1");
      toast.success("Support session started");
      navigate("/dashboard", { replace: true });
    } catch (e: any) {
      // Cleanup partial state on failure.
      try {
        localStorage.removeItem("platform_admin_session_backup_v1");
        localStorage.removeItem("platform_admin_impersonation_v1");
      } catch {
        // ignore
      }
      toast.error(friendlyAdminError(e) || e?.message || "Failed to impersonate");
    } finally {
      setImpersonating(false);
    }
  };

  return (
    <div className="p-4 md:p-6 space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="text-sm text-muted-foreground">Platform Admin</div>
          <h1 className="text-2xl font-extrabold tracking-tight">{BRAND.name}</h1>
          <div className="text-sm text-muted-foreground">Manual billing, reactivation codes, and tenant management.</div>
        </div>
      </div>

      <Card className="shadow-card">
        <CardHeader>
          <CardTitle>Create Business</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-4 gap-3 md:items-end">
          <div className="md:col-span-2 space-y-2">
            <Label>Business name</Label>
            <Input value={newBusinessName} onChange={(e) => setNewBusinessName(e.target.value)} placeholder="Tengelele Store" />
          </div>

          <div className="space-y-2">
            <Label>Plan</Label>
            <Select value={newBusinessPlan} onValueChange={(v) => setNewBusinessPlan((v as any) === "app_only" ? "app_only" : "business_system")}>
              <SelectTrigger>
                <SelectValue placeholder="business_system" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="business_system">Business System</SelectItem>
                <SelectItem value="app_only">App Only</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label>Max devices</Label>
            <Input
              value={newBusinessMaxDevices}
              onChange={(e) => setNewBusinessMaxDevices(e.target.value)}
              placeholder={newBusinessPlan === "app_only" ? "1" : "2"}
              inputMode="numeric"
            />
          </div>

          <div className="md:col-span-4 flex flex-col md:flex-row md:items-center md:justify-between gap-2">
            <div className="text-xs text-muted-foreground">
              Pricing (preview): Setup ${newBizPricing.setup} • Monthly ${newBizPricing.monthly}
              {newBusinessPlan === "app_only" ? " • Includes 1 month free" : ""}
            </div>
            <Button onClick={createBusiness}>Create</Button>
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card className="lg:col-span-2 shadow-card">
          <CardHeader>
            <CardTitle>Businesses</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="rounded-xl border border-border overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Plan</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Paid Through</TableHead>
                    <TableHead>Devices</TableHead>
                    <TableHead>State</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {!businesses.length && (
                    <TableRow>
                      <TableCell colSpan={6} className="text-sm text-muted-foreground">
                        {isFetching ? "Loading..." : "No businesses yet"}
                      </TableCell>
                    </TableRow>
                  )}
                  {businesses.map((b) => {
                    const nowMs = secureTime.timestamp();
                    const state = computeAccessState(b, nowMs);
                    const paid = b.business_billing?.paid_through ? new Date(b.business_billing.paid_through) : null;
                    const paidText = paid && !Number.isNaN(paid.getTime()) ? paid.toLocaleDateString() : "—";
                    const isSelected = selectedBusinessId === b.id;
                    const planText = b.plan_type === "app_only" ? "app_only" : "business_system";
                    const maxDevices = b.business_billing?.max_devices ?? (planText === "app_only" ? 1 : 2);

                    return (
                      <TableRow
                        key={b.id}
                        className={isSelected ? "bg-primary/6" : ""}
                        onClick={() => setSelectedBusinessId(b.id)}
                        style={{ cursor: "pointer" }}
                      >
                        <TableCell className="font-medium">{b.name}</TableCell>
                        <TableCell className="text-sm">
                          <Badge variant="outline">{planText}</Badge>
                        </TableCell>
                        <TableCell>
                          <Badge variant={b.status === "active" ? "secondary" : "destructive"}>{b.status}</Badge>
                        </TableCell>
                        <TableCell className="text-sm">
                          {paidText}
                          {paid && state !== "active" ? (
                            <span className="ml-2 text-xs text-muted-foreground">
                              ({daysFromNow(paid, nowMs)}d)
                            </span>
                          ) : null}
                        </TableCell>
                        <TableCell className="text-sm">
                          <span className="font-semibold">{maxDevices}</span>
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant={state === "active" ? "secondary" : state === "grace" ? "outline" : "destructive"}
                          >
                            {state}
                          </Badge>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>

        <Card className="shadow-card">
          <CardHeader>
            <CardTitle>Selected</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {!selected ? (
              <div className="text-sm text-muted-foreground">Select a business to manage billing and users.</div>
            ) : (
              <>
                <div className="space-y-1">
                  <div className="text-sm font-semibold">{selected.name}</div>
                  <div className="text-xs text-muted-foreground">Business ID: {selected.id}</div>
                </div>

                <div className="rounded-xl border border-border bg-card/50 px-3 py-3 space-y-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-xs text-muted-foreground">Plan</div>
                    <Badge variant="outline">{selectedPlan}</Badge>
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <div className="space-y-2">
                      <Label>Max devices</Label>
                      <Input
                        value={editMaxDevices}
                        onChange={(e) => setEditMaxDevices(e.target.value)}
                        placeholder={selectedPlan === "app_only" ? "1" : "2"}
                        inputMode="numeric"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label>Pricing</Label>
                      <div className="text-sm font-semibold">
                        Setup ${selectedPricing.setup}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        Monthly ${selectedPricing.monthly}
                        {selectedPlan === "app_only" ? " • 1 month free on activation" : ""}
                      </div>
                    </div>
                  </div>

                  <Button variant="outline" onClick={saveMaxDevicesForBusiness}>
                    Save Device Limit
                  </Button>
                </div>

                <div className="grid grid-cols-1 gap-3">
                  <div className="space-y-2">
                    <Label>Kind</Label>
                    <Select
                      value={paymentKind}
                      onValueChange={(v) => {
                        const k = v as any;
                        setPaymentKind(k);
                        if (k === "setup") {
                          setPaymentAmount(String(selectedPricing.setup));
                          setExtendMonths("0");
                        }
                        if (k === "subscription") {
                          setPaymentAmount(String(selectedPricing.monthly));
                          setExtendMonths((m) => (String(m || "").trim() === "0" ? "1" : m));
                        }
                      }}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="subscription" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="setup">Setup ({`$${selectedPricing.setup}`})</SelectItem>
                        <SelectItem value="subscription">Subscription ({`$${selectedPricing.monthly}`})</SelectItem>
                        <SelectItem value="reactivation">Reactivation</SelectItem>
                        <SelectItem value="manual">Manual</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2">
                    <Label>Amount</Label>
                    <Input value={paymentAmount} onChange={(e) => setPaymentAmount(e.target.value)} placeholder="15" inputMode="decimal" />
                  </div>

                  <div className="space-y-2">
                    <Label>Months to extend</Label>
                    <Input value={extendMonths} onChange={(e) => setExtendMonths(e.target.value)} placeholder="1" inputMode="numeric" />
                  </div>

                  <div className="flex gap-2">
                    <Button className="flex-1" onClick={recordPaymentAndActivate}>
                      Activate
                    </Button>
                    <Button className="flex-1" variant="outline" onClick={generateReactivationCode}>
                      Generate Code
                    </Button>
                  </div>

                  <div className="text-[11px] text-muted-foreground">
                    Manual billing: record the amount, then extend paid-through by months. Grace period is enforced automatically.
                  </div>
                </div>

                <div className="pt-2 border-t border-border/70">
                  <div className="text-sm font-semibold mb-2">Create Business Admin</div>
                  <div className="space-y-3">
                    <div className="space-y-2">
                      <Label>Full name</Label>
                      <Input value={newAdminFullName} onChange={(e) => setNewAdminFullName(e.target.value)} placeholder="Owner Name" />
                    </div>
                    <div className="space-y-2">
                      <Label>Username</Label>
                      <Input value={newAdminUsername} onChange={(e) => setNewAdminUsername(e.target.value)} placeholder="owner" autoCapitalize="none" autoCorrect="off" />
                    </div>
                    <div className="space-y-2">
                      <Label>Password</Label>
                      <Input value={newAdminPassword} onChange={(e) => setNewAdminPassword(e.target.value)} placeholder="••••••••" type="password" />
                    </div>
                    <Button onClick={createBusinessAdmin}>Create Admin</Button>
                    <div className="text-[11px] text-muted-foreground">
                      This creates the first admin user for the selected business (they can then add cashiers in Settings).
                    </div>
                  </div>
                </div>

                <div className="pt-2 border-t border-border/70">
                  <div className="text-sm font-semibold mb-2">Users ({selectedUsers.length})</div>
                  <div className="space-y-2 max-h-[280px] overflow-auto pos-scrollbar pr-1">
                    {!selectedUsers.length ? (
                      <div className="text-sm text-muted-foreground">No users found.</div>
                    ) : (
                      selectedUsers.map((u: any) => (
                        <div
                          key={u.id}
                          className="flex items-center justify-between gap-2 rounded-lg border border-border bg-card/60 px-3 py-2"
                        >
                          <div className="min-w-0">
                            <div className="text-sm font-medium truncate">
                              {u.full_name || u.username}
                            </div>
                            <div className="text-[11px] text-muted-foreground truncate">
                              {u.username} • {u.role}
                            </div>
                          </div>
                          <Badge variant={u.active === false ? "destructive" : "secondary"}>
                            {u.active === false ? "disabled" : "active"}
                          </Badge>
                        </div>
                      ))
                    )}
                  </div>
                </div>

                <div className="pt-2 border-t border-border/70">
                  <div className="text-sm font-semibold mb-2">
                    Devices ({selectedDevices.filter((d) => d.active).length}/
                    {selectedDeviceCap})
                  </div>
                  <div className="space-y-2 max-h-[260px] overflow-auto pos-scrollbar pr-1">
                    {!selectedDevices.length ? (
                      <div className="text-sm text-muted-foreground">No devices registered yet.</div>
                    ) : (
                      selectedDevices.map((d) => (
                        <div
                          key={d.id}
                          className="flex items-center justify-between gap-2 rounded-lg border border-border bg-card/60 px-3 py-2"
                        >
                          <div className="min-w-0">
                            <div className="text-sm font-medium truncate">{d.platform || "device"}</div>
                            <div className="text-[11px] text-muted-foreground truncate">
                              {d.device_id}
                            </div>
                            <div className="text-[11px] text-muted-foreground truncate">
                              Last seen: {d.last_seen_at ? new Date(d.last_seen_at).toLocaleString() : "—"}
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            <Badge variant={d.active ? "secondary" : "destructive"}>{d.active ? "active" : "off"}</Badge>
                            <Button
                              size="sm"
                              variant={d.active ? "outline" : "default"}
                              onClick={() => toggleDeviceActive(d, !d.active)}
                            >
                              {d.active ? "Deactivate" : "Activate"}
                            </Button>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                  <div className="text-[11px] text-muted-foreground mt-2">
                    {selectedPlan === "app_only"
                      ? "App-only plan: default license is 1 active device. Increase max devices if needed."
                      : "Business system plan: default license is 2 active devices (1 computer + 1 mobile). Deactivate old devices to free a slot."}
                  </div>
                </div>

                <div className="pt-2 border-t border-border/70">
                  <div className="text-sm font-semibold mb-2">Support Mode (Impersonate)</div>
                  <div className="space-y-3">
                    <div className="space-y-2">
                      <Label>Role</Label>
                      <Select value={impersonationRole} onValueChange={(v) => setImpersonationRole((v as any) === "cashier" ? "cashier" : "admin")}>
                        <SelectTrigger>
                          <SelectValue placeholder="admin" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="admin">Admin</SelectItem>
                          <SelectItem value="cashier">Cashier</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-2">
                      <Label>Reason</Label>
                      <Input
                        value={impersonationReason}
                        onChange={(e) => setImpersonationReason(e.target.value)}
                        placeholder="Customer support / debugging / training"
                      />
                    </div>
                    <Button onClick={startImpersonation} disabled={impersonating}>
                      {impersonating ? "Starting…" : "Impersonate Business"}
                    </Button>
                    <div className="text-[11px] text-muted-foreground">
                      This switches your session into the selected business. A banner will appear with “Return to Platform Admin”.
                    </div>
                  </div>
                </div>

                <div className="pt-2 border-t border-border/70">
                  <div className="text-sm font-semibold mb-2">Activity</div>

                  <div className="space-y-2">
                    <div className="text-xs font-semibold text-muted-foreground">Payments (latest)</div>
                    <div className="space-y-2 max-h-[220px] overflow-auto pos-scrollbar pr-1">
                      {!selectedPayments.length ? (
                        <div className="text-sm text-muted-foreground">No payments recorded.</div>
                      ) : (
                        selectedPayments.map((p) => (
                          <div
                            key={p.id}
                            className="flex items-center justify-between gap-2 rounded-lg border border-border bg-card/60 px-3 py-2"
                          >
                            <div className="min-w-0">
                              <div className="text-sm font-medium truncate">
                                {p.kind} • {Number(p.amount).toFixed(2)} {p.currency}
                              </div>
                              <div className="text-[11px] text-muted-foreground truncate">
                                {p.created_at ? new Date(p.created_at).toLocaleString() : "—"}
                              </div>
                            </div>
                            <Badge variant="outline">{p.kind}</Badge>
                          </div>
                        ))
                      )}
                    </div>
                  </div>

                  <div className="space-y-2 pt-2">
                    <div className="text-xs font-semibold text-muted-foreground">Reactivation Codes (latest)</div>
                    <div className="space-y-2 max-h-[220px] overflow-auto pos-scrollbar pr-1">
                      {!selectedCodes.length ? (
                        <div className="text-sm text-muted-foreground">No codes issued.</div>
                      ) : (
                        selectedCodes.map((c) => (
                          <div
                            key={c.id}
                            className="flex items-center justify-between gap-2 rounded-lg border border-border bg-card/60 px-3 py-2"
                          >
                            <div className="min-w-0">
                              <div className="text-sm font-medium truncate">
                                {c.code_prefix ? `${c.code_prefix}…` : "code"} • {c.months} month(s)
                              </div>
                              <div className="text-[11px] text-muted-foreground truncate">
                                Issued: {c.issued_at ? new Date(c.issued_at).toLocaleString() : "—"}
                              </div>
                              {c.redeemed_at ? (
                                <div className="text-[11px] text-muted-foreground truncate">
                                  Redeemed: {new Date(c.redeemed_at).toLocaleString()}
                                </div>
                              ) : null}
                            </div>
                            <Badge variant={c.redeemed_at ? "secondary" : c.active ? "outline" : "destructive"}>
                              {c.redeemed_at ? "redeemed" : c.active ? "active" : "off"}
                            </Badge>
                          </div>
                        ))
                      )}
                    </div>
                  </div>

                  <div className="space-y-2 pt-2">
                    <div className="text-xs font-semibold text-muted-foreground">Impersonation (latest)</div>
                    <div className="space-y-2 max-h-[220px] overflow-auto pos-scrollbar pr-1">
                      {!selectedImpersonations.length ? (
                        <div className="text-sm text-muted-foreground">No impersonations yet.</div>
                      ) : (
                        selectedImpersonations.map((a) => (
                          <div
                            key={a.id}
                            className="flex items-center justify-between gap-2 rounded-lg border border-border bg-card/60 px-3 py-2"
                          >
                            <div className="min-w-0">
                              <div className="text-sm font-medium truncate">{a.reason}</div>
                              <div className="text-[11px] text-muted-foreground truncate">
                                {a.created_at ? new Date(a.created_at).toLocaleString() : "—"}
                              </div>
                            </div>
                            <Badge variant={a.ended_at ? "secondary" : "outline"}>
                              {a.ended_at ? "ended" : "active"}
                            </Badge>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
