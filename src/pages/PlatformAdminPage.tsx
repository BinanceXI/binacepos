import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { supabase } from "@/lib/supabase";
import { BRAND } from "@/lib/brand";
import { ensureSupabaseSession } from "@/lib/supabaseSession";
import {
  computePlanPricing,
  DEFAULT_PRICING_PLANS,
  type PlanType,
  type PricingPlanMap,
  type PricingPlanRow,
} from "@/lib/pricing";
import { secureTime } from "@/lib/secureTime";
import { usePOS } from "@/contexts/POSContext";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

type TenantHealthRow = {
  business_id: string;
  name: string;
  status: "active" | "suspended" | string;
  plan_type?: "business_system" | "app_only" | string | null;
  paid_through: string | null;
  grace_days: number | null;
  locked_override: boolean | null;
  max_devices: number | null;
  active_devices: number | null;
  last_seen_at: string | null;
  last_order_at: string | null;
  access_state: "active" | "grace" | "locked" | string;
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
  kind: "setup" | "subscription" | "annual" | "reactivation" | "manual" | string;
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

type PlatformPaymentRow = PaymentRow & {
  business_id: string;
  businesses?: { name?: string | null } | null;
};

type FeedbackRow = {
  id: string;
  created_at: string;
  business_id: string;
  user_id: string | null;
  type: "bug" | "feature" | "review" | string;
  rating: number | null;
  title: string;
  message: string;
  severity: "low" | "medium" | "high" | string;
  status: "new" | "triaged" | "in_progress" | "done" | "wont_fix" | string;
  app_version: string | null;
  platform: string | null;
  route: string | null;
  businesses?: { name?: string | null } | null;
  profiles?: { username?: string | null; full_name?: string | null } | null;
};

function daysFromNow(d: Date, nowMs: number) {
  return Math.ceil((d.getTime() - nowMs) / (24 * 60 * 60 * 1000));
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
  const lower = msg.toLowerCase();

  // PostgREST often returns 404 for unauthorized RPCs.
  if (status === 404)
    return "Not authorized (cloud session missing). Sign out and sign in again while online.";
  if (status === 401)
    return "Cloud session missing. Sign out and sign in again while online.";
  if (status === 403) return "Access denied.";
  if (lower.includes("missing or invalid user session")) {
    return "Cloud session missing. Sign out and sign in again while online.";
  }

  if (
    lower.includes("foreign key") ||
    lower.includes("constraint") ||
    lower.includes("related records")
  ) {
    return "Cannot permanently delete this user because linked history exists. Deactivate instead.";
  }

  return msg || "Request failed";
}

export function PlatformAdminPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { setCurrentUser, currentUser } = usePOS();

  const [tab, setTab] = useState<
    "overview" | "tenants" | "billing" | "feedback" | "pricing"
  >("overview");

  const [newBusinessName, setNewBusinessName] = useState("");
  const [newBusinessPlan, setNewBusinessPlan] =
    useState<PlanType>("business_system");
  const [newBusinessMaxDevices, setNewBusinessMaxDevices] = useState("2");
  const [selectedBusinessId, setSelectedBusinessId] = useState<string | null>(
    null
  );

  const [paymentAmount, setPaymentAmount] = useState("5");
  const [paymentKind, setPaymentKind] = useState<
    "setup" | "subscription" | "annual" | "reactivation" | "manual"
  >("subscription");
  const [extendMonths, setExtendMonths] = useState("1");

  const [newAdminFullName, setNewAdminFullName] = useState("");
  const [newAdminUsername, setNewAdminUsername] = useState("");
  const [newAdminPassword, setNewAdminPassword] = useState("");

  const [editMaxDevices, setEditMaxDevices] = useState<string>("");
  const [tenantSearch, setTenantSearch] = useState("");
  const [billingSearch, setBillingSearch] = useState("");

  const [feedbackStatus, setFeedbackStatus] = useState<
    "all" | FeedbackRow["status"]
  >("all");
  const [feedbackType, setFeedbackType] = useState<"all" | FeedbackRow["type"]>(
    "all"
  );
  const [feedbackSeverity, setFeedbackSeverity] = useState<
    "all" | FeedbackRow["severity"]
  >("all");

  const [softDeleteReason, setSoftDeleteReason] = useState("");

  const [impersonationReason, setImpersonationReason] = useState("");
  const [impersonationRole, setImpersonationRole] = useState<
    "admin" | "cashier"
  >("admin");
  const [impersonating, setImpersonating] = useState(false);

  const toNum = (v: any, fallback = 0) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  };
  const fmtMoney = (v: any) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return "0";
    return Number.isInteger(n) ? String(n) : n.toFixed(2);
  };

  const { data: pricingPlans = DEFAULT_PRICING_PLANS } = useQuery({
    queryKey: ["platform", "pricingPlans"],
    queryFn: async (): Promise<PricingPlanMap> => {
      try {
        const { data, error } = await supabase
          .from("pricing_plans")
          .select(
            "plan_type, included_devices, setup_base, setup_per_extra, monthly_base, monthly_per_extra, annual_base, annual_months, updated_at"
          )
          .order("plan_type", { ascending: true });
        if (error) throw error;

        const out: PricingPlanMap = { ...DEFAULT_PRICING_PLANS };
        for (const r of (data || []) as any[]) {
          const pt = String((r as any)?.plan_type || "").trim();
          const plan_type: PlanType | null =
            pt === "app_only"
              ? "app_only"
              : pt === "business_system"
                ? "business_system"
                : null;
          if (!plan_type) continue;

          const base = out[plan_type];
          out[plan_type] = {
            plan_type,
            included_devices: Math.max(
              1,
              Math.min(50, toNum((r as any)?.included_devices, base.included_devices))
            ),
            setup_base: Math.max(0, toNum((r as any)?.setup_base, base.setup_base)),
            setup_per_extra: Math.max(
              0,
              toNum((r as any)?.setup_per_extra, base.setup_per_extra)
            ),
            monthly_base: Math.max(
              0,
              toNum((r as any)?.monthly_base, base.monthly_base)
            ),
            monthly_per_extra: Math.max(
              0,
              toNum((r as any)?.monthly_per_extra, base.monthly_per_extra)
            ),
            annual_base: Math.max(0, toNum((r as any)?.annual_base, base.annual_base)),
            annual_months: Math.max(
              1,
              Math.min(36, toNum((r as any)?.annual_months, base.annual_months))
            ),
          } satisfies PricingPlanRow;
        }

        return out;
      } catch {
        // Backward compatible: when the table isn't migrated yet, fall back to code defaults.
        return DEFAULT_PRICING_PLANS;
      }
    },
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  const [pricingDraft, setPricingDraft] =
    useState<PricingPlanMap>(DEFAULT_PRICING_PLANS);
  useEffect(() => {
    setPricingDraft(pricingPlans);
  }, [pricingPlans]);

  const { data: kpis } = useQuery({
    queryKey: ["platform", "kpis"],
    queryFn: async () => {
      try {
        const { data, error } = await supabase.rpc("platform_kpis");
        if (error) throw error;
        return data as any;
      } catch {
        // Function may not exist pre-migration.
        return null;
      }
    },
    staleTime: 10_000,
    refetchOnWindowFocus: false,
  });

  const { data: businesses = [], isFetching: isFetchingBusinesses } = useQuery({
    queryKey: ["platform", "tenantHealth"],
    queryFn: async () => {
      // Preferred: server-side computed tenant health (fast + consistent)
      try {
        const { data, error } = await supabase.rpc("platform_tenant_health");
        if (!error && Array.isArray(data)) return data as unknown as TenantHealthRow[];
      } catch {
        // ignore
      }

      // Fallback: older deployments without the RPC.
      const { data, error } = await supabase
        .from("businesses")
        .select(
          "id, name, status, plan_type, created_at, business_billing(paid_through, grace_days, locked_override, currency, max_devices)"
        )
        .order("created_at", { ascending: false });
      if (error) throw error;

      const nowMs = secureTime.timestamp();
      const now = new Date(nowMs);

      return ((data || []) as any[]).map((b) => {
        const paidRaw = (b as any)?.business_billing?.paid_through || null;
        const graceDays = toNum((b as any)?.business_billing?.grace_days, 7);
        const lockedOverride = (b as any)?.business_billing?.locked_override === true;
        const paid = paidRaw ? new Date(paidRaw) : null;

        let access_state: "active" | "grace" | "locked" = "locked";
        if (String((b as any)?.status || "") === "suspended" || lockedOverride) {
          access_state = "locked";
        } else if (paid && !Number.isNaN(paid.getTime())) {
          const graceEnd = new Date(paid.getTime() + graceDays * 24 * 60 * 60 * 1000);
          if (now <= paid) access_state = "active";
          else if (now <= graceEnd) access_state = "grace";
          else access_state = "locked";
        }

        const planText =
          String((b as any)?.plan_type || "").trim() === "app_only"
            ? "app_only"
            : "business_system";
        const maxDevices = toNum((b as any)?.business_billing?.max_devices, 2);

        return {
          business_id: String((b as any)?.id),
          name: String((b as any)?.name || ""),
          status: String((b as any)?.status || "active"),
          plan_type: planText,
          paid_through: paidRaw ? String(paidRaw) : null,
          grace_days: graceDays,
          locked_override: lockedOverride,
          max_devices: maxDevices,
          active_devices: null,
          last_seen_at: null,
          last_order_at: null,
          access_state,
        } satisfies TenantHealthRow;
      });
    },
    staleTime: 15_000,
    refetchOnWindowFocus: false,
  });

  const selected = useMemo(
    () => businesses.find((b) => b.business_id === selectedBusinessId) || null,
    [businesses, selectedBusinessId]
  );

  const selectedPlan: PlanType =
    selected?.plan_type === "app_only" ? "app_only" : "business_system";
  const selectedDeviceCap = Math.max(
    1,
    Math.min(50, Number(selected?.max_devices ?? 2) || 2)
  );
  const selectedPricing = useMemo(
    () => computePlanPricing(selectedPlan, selectedDeviceCap, pricingPlans),
    [selectedPlan, selectedDeviceCap, pricingPlans]
  );

  const newBizDeviceCap = Math.max(
    1,
    Math.min(50, Number(newBusinessMaxDevices) || 2)
  );
  const newBizPricing = useMemo(
    () => computePlanPricing(newBusinessPlan, newBizDeviceCap, pricingPlans),
    [newBusinessPlan, newBizDeviceCap, pricingPlans]
  );

  useEffect(() => {
    // Pricing model: both plans include 2 devices by default.
    setNewBusinessMaxDevices("2");
  }, [newBusinessPlan]);

  useEffect(() => {
    if (!selected) {
      setEditMaxDevices("");
      return;
    }
    setEditMaxDevices(String(selectedDeviceCap));
  }, [selected, selected?.business_id, selectedDeviceCap]);

  useEffect(() => {
    if (!selected) return;
    if (paymentKind === "setup") {
      setPaymentAmount(String(selectedPricing.setup));
      setExtendMonths("0");
      return;
    }
    if (paymentKind === "subscription") {
      setPaymentAmount(String(selectedPricing.monthly));
      if (String(extendMonths || "").trim() === "0") setExtendMonths("1");
      return;
    }
    if (paymentKind === "annual") {
      setPaymentAmount(String(selectedPricing.annual_base));
      setExtendMonths(String(selectedPricing.annual_months));
      return;
    }
  }, [
    selected,
    selected?.business_id,
    paymentKind,
    selectedPricing.setup,
    selectedPricing.monthly,
    selectedPricing.annual_base,
    selectedPricing.annual_months,
    extendMonths,
  ]);

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
        .select(
          "id, device_id, platform, device_label, active, registered_at, last_seen_at"
        )
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
    toast.error(
      "Cloud session missing. Sign out and sign in again while online."
    );
    return false;
  };

  const createBusiness = async () => {
    const name = String(newBusinessName || "").trim();
    if (!name) return toast.error("Business name required");

    try {
      if (!(await requireCloudSession())) return;
      const plan_type: PlanType =
        newBusinessPlan === "app_only" ? "app_only" : "business_system";
      const max_devices = Math.max(
        1,
        Math.min(50, Number(newBusinessMaxDevices) || 2)
      );

      const { data, error } = await supabase
        .from("businesses")
        .insert({ name, status: "active", plan_type })
        .select("id, name, status, plan_type, created_at")
        .single();
      if (error) throw error;

      // Ensure device cap is set explicitly (defaults are plan-based).
      if (data?.id) {
        await supabase
          .from("business_billing")
          .update({ max_devices })
          .eq("business_id", data.id);
      }

      toast.success(`Created ${data?.name || "business"}`);
      setNewBusinessName("");
      await qc.invalidateQueries({ queryKey: ["platform", "tenantHealth"] });
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
    if (!username || username.length < 3)
      return toast.error("Username must be 3+ characters");
    if (password.length < 6)
      return toast.error("Password must be at least 6 characters");

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

      const { data: fnData, error: fnErr } = await supabase.functions.invoke(
        "create_staff_user",
        {
          body: {
            business_id: selected.business_id,
            username,
            password,
            full_name,
            role: "admin",
            permissions: adminPerms,
          },
        }
      );

      if (fnErr) throw fnErr;
      if ((fnData as any)?.error) throw new Error((fnData as any).error);

      toast.success(`Created admin @${username}`);
      setNewAdminFullName("");
      setNewAdminUsername("");
      setNewAdminPassword("");
      await qc.invalidateQueries({
        queryKey: ["platform", "businessUsers", selected.business_id],
      });
    } catch (e: any) {
      toast.error(friendlyAdminError(e) || "Failed to create business admin");
    }
  };

  const toggleDeviceActive = async (device: DeviceRow, nextActive: boolean) => {
    if (!selected) return toast.error("Select a business");
    try {
      if (!(await requireCloudSession())) return;
      const { error } = await supabase
        .from("business_devices")
        .update({ active: nextActive })
        .eq("id", device.id);
      if (error) throw error;
      toast.success(nextActive ? "Device reactivated" : "Device deactivated");
      await qc.invalidateQueries({
        queryKey: ["platform", "businessDevices", selected.business_id],
      });
    } catch (e: any) {
      toast.error(friendlyAdminError(e) || "Failed to update device");
    }
  };

  const saveMaxDevicesForBusiness = async () => {
    if (!selected) return toast.error("Select a business");
    const next = Math.max(1, Math.min(50, Number(editMaxDevices) || 0));
    if (!Number.isFinite(next) || next <= 0)
      return toast.error("Enter a valid device limit");

    try {
      if (!(await requireCloudSession())) return;
      const { error } = await supabase
        .from("business_billing")
        .update({ max_devices: next })
        .eq("business_id", selected.business_id);
      if (error) throw error;

      toast.success("Updated device limit");
      await qc.invalidateQueries({ queryKey: ["platform", "tenantHealth"] });
    } catch (e: any) {
      toast.error(friendlyAdminError(e) || "Failed to update device limit");
    }
  };

  const recordPaymentAndActivate = async () => {
    if (!selected) return toast.error("Select a business");

    const amount = Number(paymentAmount);
    const months = Math.max(0, Math.min(24, Number(extendMonths) || 0));
    if (!Number.isFinite(amount) || amount <= 0)
      return toast.error("Enter a valid amount");

    try {
      if (!(await requireCloudSession())) return;
      // 1) Record payment
      const currency = "USD";
      const { error: payErr } = await supabase.from("billing_payments").insert({
        business_id: selected.business_id,
        amount,
        currency,
        kind: paymentKind,
        notes: null,
      });
      if (payErr) throw payErr;

      // 2) Extend subscription
      if (months > 0) {
        const nowMs = secureTime.timestamp();
        const currentPaid = selected.paid_through
          ? new Date(selected.paid_through)
          : new Date(0);
        const base = new Date(Math.max(nowMs, currentPaid.getTime()));
        const next = new Date(base.getTime() + months * 30 * 24 * 60 * 60 * 1000);

        const { error: billErr } = await supabase
          .from("business_billing")
          .update({ paid_through: next.toISOString(), locked_override: false })
          .eq("business_id", selected.business_id);
        if (billErr) throw billErr;
      }

      toast.success(months > 0 ? `Extended by ${months} month(s)` : "Payment recorded");
      await qc.invalidateQueries({ queryKey: ["platform", "tenantHealth"] });
      await qc.invalidateQueries({
        queryKey: ["platform", "businessPayments", selected.business_id],
      });
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
        p_business_id: selected.business_id,
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

  const setUserActive = async (userId: string, nextActive: boolean) => {
    if (!selected) return toast.error("Select a business");
    if (!userId) return;
    if (String(currentUser?.id || "") === userId) {
      return toast.error("You cannot modify your own account here");
    }

    try {
      if (!(await requireCloudSession())) return;
      const { error } = await supabase
        .from("profiles")
        .update({ active: nextActive })
        .eq("id", userId);
      if (error) throw error;

      toast.success(nextActive ? "User activated" : "User deactivated");
      await qc.invalidateQueries({
        queryKey: ["platform", "businessUsers", selected.business_id],
      });
    } catch (e: any) {
      toast.error(friendlyAdminError(e) || "Failed to update user");
    }
  };

  const deleteUser = async (userId: string) => {
    if (!selected) return toast.error("Select a business");
    if (!userId) return;
    if (String(currentUser?.id || "") === userId) {
      return toast.error("You cannot delete your own account");
    }

    const ok = window.confirm(
      "Delete this user?\n\nThis attempts to remove the Supabase Auth user and profile. If they have related orders, deletion may fail; deactivate instead."
    );
    if (!ok) return;

    try {
      if (!(await requireCloudSession())) return;
      const { data, error } = await supabase.functions.invoke(
        "delete_staff_user",
        {
          body: { user_id: userId },
        }
      );
      if (error) throw error;
      if ((data as any)?.error) throw new Error((data as any).error);

      toast.success("User deleted");
      await qc.invalidateQueries({
        queryKey: ["platform", "businessUsers", selected.business_id],
      });
    } catch (e: any) {
      toast.error(friendlyAdminError(e) || "Delete failed");
    }
  };

  const softDeleteSelectedBusiness = async () => {
    if (!selected) return toast.error("Select a business");
    const reason = String(softDeleteReason || "").trim();
    if (!reason) return toast.error("Enter a reason for soft-delete");

    const ok = window.confirm(
      `Soft-delete "${selected.name}"?\n\nThis will suspend access, lock billing, disable users, and disable devices.`
    );
    if (!ok) return;

    try {
      if (!(await requireCloudSession())) return;
      const { error } = await supabase.rpc("soft_delete_business", {
        p_business_id: selected.business_id,
        p_reason: reason,
      });
      if (error) throw error;

      toast.success("Business suspended (soft-deleted)");
      setSoftDeleteReason("");
      await qc.invalidateQueries({ queryKey: ["platform", "tenantHealth"] });
      await qc.invalidateQueries({
        queryKey: ["platform", "businessUsers", selected.business_id],
      });
      await qc.invalidateQueries({
        queryKey: ["platform", "businessDevices", selected.business_id],
      });
    } catch (e: any) {
      toast.error(friendlyAdminError(e) || "Soft-delete failed");
    }
  };

  const restoreSelectedBusiness = async () => {
    if (!selected) return toast.error("Select a business");
    const ok = window.confirm(
      `Restore "${selected.name}"?\n\nThis will reactivate access and remove the lock override.`
    );
    if (!ok) return;

    try {
      if (!(await requireCloudSession())) return;
      const { error } = await supabase.rpc("restore_business", {
        p_business_id: selected.business_id,
      });
      if (error) throw error;

      toast.success("Business restored");
      await qc.invalidateQueries({ queryKey: ["platform", "tenantHealth"] });
    } catch (e: any) {
      toast.error(friendlyAdminError(e) || "Restore failed");
    }
  };

  const startImpersonation = async () => {
    if (!selected) return toast.error("Select a business");
    if (!navigator.onLine)
      return toast.error("Impersonation requires an internet connection");

    const reason = String(impersonationReason || "").trim();
    if (reason.length < 3)
      return toast.error("Enter a short reason (3+ chars)");

    if (impersonating) return;
    setImpersonating(true);
    try {
      if (!(await requireCloudSession())) return;

      const session = (await supabase.auth.getSession()).data.session;
      if (!session?.access_token || !session?.refresh_token) {
        throw new Error(
          "Cloud session missing. Sign out and sign in again while online."
        );
      }

      const { data: out, error: fnErr } = await supabase.functions.invoke(
        "impersonate_business",
        {
          body: {
            business_id: selected.business_id,
            role: impersonationRole,
            reason,
          },
        }
      );
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
          business_id: selected.business_id,
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
      if (!otp?.session?.access_token)
        throw new Error("Failed to mint support session");

      const { data: u, error: uErr } = await supabase.auth.getUser();
      if (uErr || !u?.user?.id) throw uErr || new Error("Failed to load user");

      const { data: profile, error: pErr } = await supabase
        .from("profiles")
        .select(
          "id, username, full_name, role, permissions, active, business_id, is_support"
        )
        .eq("id", u.user.id)
        .maybeSingle();
      if (pErr || !profile) throw pErr || new Error("Failed to load profile");
      if ((profile as any)?.active === false)
        throw new Error("Support account disabled");
      if ((profile as any)?.is_support !== true)
        throw new Error("Not a support account");

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

  const { data: platformPayments = [], isFetching: isFetchingPlatformPayments } =
    useQuery({
      queryKey: ["platform", "payments"],
      queryFn: async () => {
        try {
          const { data, error } = await supabase
            .from("billing_payments")
            .select("id, amount, currency, kind, notes, created_at, business_id, businesses(name)")
            .order("created_at", { ascending: false })
            .limit(250);
          if (error) throw error;
          return (data || []) as unknown as PlatformPaymentRow[];
        } catch {
          // Backward compatible if RLS/table not ready.
          return [] as PlatformPaymentRow[];
        }
      },
      enabled: tab === "billing",
      staleTime: 15_000,
      refetchOnWindowFocus: false,
    });

  const { data: platformFeedback = [], isFetching: isFetchingPlatformFeedback } =
    useQuery({
      queryKey: ["platform", "feedback", feedbackStatus, feedbackType, feedbackSeverity],
      queryFn: async () => {
        try {
          let q = supabase
            .from("app_feedback")
            .select(
              "id, created_at, business_id, user_id, type, rating, title, message, severity, status, app_version, platform, route, businesses(name), profiles(username, full_name)"
            )
            .order("created_at", { ascending: false })
            .limit(250);

          if (feedbackStatus !== "all") q = q.eq("status", feedbackStatus);
          if (feedbackType !== "all") q = q.eq("type", feedbackType);
          if (feedbackSeverity !== "all") q = q.eq("severity", feedbackSeverity);

          const { data, error } = await q;
          if (error) throw error;
          return (data || []) as unknown as FeedbackRow[];
        } catch {
          // Backward compatible if table/RLS not ready.
          return [] as FeedbackRow[];
        }
      },
      enabled: tab === "feedback",
      staleTime: 10_000,
      refetchOnWindowFocus: false,
    });

  const updateFeedbackStatus = async (
    row: FeedbackRow,
    next: FeedbackRow["status"]
  ) => {
    try {
      if (!(await requireCloudSession())) return;
      const { error } = await supabase
        .from("app_feedback")
        .update({ status: next })
        .eq("id", row.id);
      if (error) throw error;

      toast.success("Feedback updated");
      await qc.invalidateQueries({ queryKey: ["platform", "feedback"] });
    } catch (e: any) {
      toast.error(friendlyAdminError(e) || "Failed to update feedback");
    }
  };

  const savePricing = async () => {
    try {
      if (!(await requireCloudSession())) return;

      const clampInt = (n: number, min: number, max: number) => {
        const x = Number(n);
        if (!Number.isFinite(x)) return min;
        return Math.max(min, Math.min(max, Math.trunc(x)));
      };
      const clampMoney = (n: number) => {
        const x = Number(n);
        if (!Number.isFinite(x)) return 0;
        return Math.max(0, Math.round(x * 100) / 100);
      };

      const rows = (["business_system", "app_only"] as PlanType[]).map((pt) => {
        const p = pricingDraft[pt] || pricingPlans[pt] || DEFAULT_PRICING_PLANS[pt];
        return {
          plan_type: pt,
          included_devices: clampInt(toNum((p as any).included_devices, 2), 1, 50),
          setup_base: clampMoney(toNum((p as any).setup_base, 0)),
          setup_per_extra: clampMoney(toNum((p as any).setup_per_extra, 0)),
          monthly_base: clampMoney(toNum((p as any).monthly_base, 0)),
          monthly_per_extra: clampMoney(toNum((p as any).monthly_per_extra, 0)),
          annual_base: clampMoney(toNum((p as any).annual_base, 0)),
          annual_months: clampInt(toNum((p as any).annual_months, 12), 1, 36),
        };
      });

      const { error } = await supabase
        .from("pricing_plans")
        .upsert(rows as any, { onConflict: "plan_type" });
      if (error) throw error;

      toast.success("Pricing updated");
      await qc.invalidateQueries({ queryKey: ["platform", "pricingPlans"] });
    } catch (e: any) {
      toast.error(friendlyAdminError(e) || "Failed to save pricing");
    }
  };

  const filteredBusinesses = useMemo(() => {
    const q = String(tenantSearch || "").trim().toLowerCase();
    if (!q) return businesses;
    return businesses.filter((b) => {
      const name = String(b.name || "").toLowerCase();
      const id = String(b.business_id || "").toLowerCase();
      return name.includes(q) || id.includes(q);
    });
  }, [businesses, tenantSearch]);

  return (
    <div className="p-4 md:p-6 space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="text-sm text-muted-foreground">Platform Admin</div>
          <h1 className="text-2xl font-extrabold tracking-tight">{BRAND.name}</h1>
          <div className="text-sm text-muted-foreground">
            God&apos;s Eye console: tenants, billing, feedback, and pricing.
          </div>
        </div>
      </div>

      <Tabs value={tab} onValueChange={(v) => setTab((v as any) || "overview")}>
        <TabsList className="grid grid-cols-2 md:grid-cols-5 gap-1">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="tenants">Tenants</TabsTrigger>
          <TabsTrigger value="billing">Billing</TabsTrigger>
          <TabsTrigger value="feedback">Feedback</TabsTrigger>
          <TabsTrigger value="pricing">Pricing</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
            <Card className="shadow-card">
              <CardHeader>
                <CardTitle>Tenants</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <div className="text-3xl font-extrabold">
                  {kpis?.tenants?.total ?? "—"}
                </div>
                <div className="text-sm text-muted-foreground">
                  Active: {kpis?.tenants?.active ?? "—"} • Suspended:{" "}
                  {kpis?.tenants?.suspended ?? "—"}
                </div>
                <div className="text-sm text-muted-foreground">
                  Locked: {kpis?.tenants?.locked ?? "—"} • Grace:{" "}
                  {kpis?.tenants?.grace ?? "—"}
                </div>
              </CardContent>
            </Card>

            <Card className="shadow-card">
              <CardHeader>
                <CardTitle>Payments (30d)</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <div className="text-3xl font-extrabold">
                  ${fmtMoney(kpis?.payments_30d?.total_amount ?? 0)}
                </div>
                <div className="text-sm text-muted-foreground">
                  Count: {kpis?.payments_30d?.count ?? "—"}
                </div>
              </CardContent>
            </Card>

            <Card className="shadow-card">
              <CardHeader>
                <CardTitle>Orders (7d)</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <div className="text-3xl font-extrabold">
                  {kpis?.orders_7d?.count ?? "—"}
                </div>
                <div className="text-sm text-muted-foreground">
                  Total: ${fmtMoney(kpis?.orders_7d?.total_amount ?? 0)}
                </div>
              </CardContent>
            </Card>

            <Card className="shadow-card">
              <CardHeader>
                <CardTitle>Feedback</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <div className="text-3xl font-extrabold">
                  {kpis?.feedback?.open ?? "—"}
                </div>
                <div className="text-sm text-muted-foreground">
                  New: {kpis?.feedback?.new ?? "—"}
                </div>
              </CardContent>
            </Card>
          </div>

          <Card className="shadow-card">
            <CardHeader>
              <CardTitle>Device Fleet</CardTitle>
            </CardHeader>
            <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="rounded-xl border border-border bg-card/60 px-4 py-3">
                <div className="text-xs text-muted-foreground">Active devices</div>
                <div className="text-2xl font-extrabold">
                  {kpis?.devices?.active ?? "—"}
                </div>
              </div>
              <div className="rounded-xl border border-border bg-card/60 px-4 py-3">
                <div className="text-xs text-muted-foreground">Seen (24h)</div>
                <div className="text-2xl font-extrabold">
                  {kpis?.devices?.seen_24h ?? "—"}
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="tenants" className="space-y-4">
          <Card className="shadow-card">
            <CardHeader>
              <CardTitle>Create Business</CardTitle>
            </CardHeader>
            <CardContent className="grid grid-cols-1 md:grid-cols-4 gap-3 md:items-end">
              <div className="md:col-span-2 space-y-2">
                <Label>Business name</Label>
                <Input
                  value={newBusinessName}
                  onChange={(e) => setNewBusinessName(e.target.value)}
                  placeholder="Tengelele Store"
                />
              </div>

              <div className="space-y-2">
                <Label>Plan</Label>
                <Select
                  value={newBusinessPlan}
                  onValueChange={(v) =>
                    setNewBusinessPlan(
                      (v as any) === "app_only" ? "app_only" : "business_system"
                    )
                  }
                >
                  <SelectTrigger>
                    <SelectValue placeholder="business_system" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="business_system">
                      Business System
                    </SelectItem>
                    <SelectItem value="app_only">App Only</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label>Max devices</Label>
                <Input
                  value={newBusinessMaxDevices}
                  onChange={(e) => setNewBusinessMaxDevices(e.target.value)}
                  placeholder="2"
                  inputMode="numeric"
                />
              </div>

              <div className="md:col-span-4 flex flex-col md:flex-row md:items-center md:justify-between gap-2">
                <div className="text-xs text-muted-foreground">
                  Pricing (preview): Setup ${newBizPricing.setup} • Monthly $
                  {newBizPricing.monthly} • Annual ${newBizPricing.annual_base}
                  {newBusinessPlan === "app_only"
                    ? " • Includes 1 month free"
                    : ""}
                </div>
                <Button onClick={createBusiness}>Create</Button>
              </div>
            </CardContent>
          </Card>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <Card className="lg:col-span-2 shadow-card">
              <CardHeader>
                <div className="flex items-end justify-between gap-2">
                  <CardTitle>Tenants</CardTitle>
                  <div className="w-[240px] max-w-full">
                    <Input
                      value={tenantSearch}
                      onChange={(e) => setTenantSearch(e.target.value)}
                      placeholder="Search name / id"
                    />
                  </div>
                </div>
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
                      {!filteredBusinesses.length ? (
                        <TableRow>
                          <TableCell
                            colSpan={6}
                            className="text-sm text-muted-foreground"
                          >
                            {isFetchingBusinesses
                              ? "Loading..."
                              : "No tenants found"}
                          </TableCell>
                        </TableRow>
                      ) : (
                        filteredBusinesses.map((b) => {
                          const nowMs = secureTime.timestamp();
                          const paid = b.paid_through ? new Date(b.paid_through) : null;
                          const paidText =
                            paid && !Number.isNaN(paid.getTime())
                              ? paid.toLocaleDateString()
                              : "—";
                          const isSelected = selectedBusinessId === b.business_id;
                          const planText =
                            b.plan_type === "app_only"
                              ? "app_only"
                              : "business_system";
                          const cap = b.max_devices ?? 2;
                          const activeDev = b.active_devices ?? null;
                          const state = b.access_state || "locked";

                          return (
                            <TableRow
                              key={b.business_id}
                              className={isSelected ? "bg-primary/6" : ""}
                              onClick={() => setSelectedBusinessId(b.business_id)}
                              style={{ cursor: "pointer" }}
                            >
                              <TableCell className="font-medium">
                                {b.name}
                              </TableCell>
                              <TableCell className="text-sm">
                                <Badge variant="outline">{planText}</Badge>
                              </TableCell>
                              <TableCell>
                                <Badge
                                  variant={
                                    b.status === "active"
                                      ? "secondary"
                                      : "destructive"
                                  }
                                >
                                  {b.status}
                                </Badge>
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
                                {activeDev === null ? (
                                  <span className="text-muted-foreground">—</span>
                                ) : (
                                  <span className="font-semibold">{activeDev}</span>
                                )}
                                <span className="text-muted-foreground">/{cap ?? "—"}</span>
                              </TableCell>
                              <TableCell>
                                <Badge
                                  variant={
                                    state === "active"
                                      ? "secondary"
                                      : state === "grace"
                                        ? "outline"
                                        : "destructive"
                                  }
                                >
                                  {state}
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
                <CardTitle>Selected Tenant</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {!selected ? (
                  <div className="text-sm text-muted-foreground">
                    Select a tenant to manage billing, users, and devices.
                  </div>
                ) : (
                  <>
                    <div className="space-y-1">
                      <div className="text-sm font-semibold">{selected.name}</div>
                      <div className="text-xs text-muted-foreground">
                        Business ID: {selected.business_id}
                      </div>
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
                            placeholder="2"
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
                          </div>
                          <div className="text-xs text-muted-foreground">
                            Annual ${selectedPricing.annual_base}
                          </div>
                        </div>
                      </div>

                      <Button variant="outline" onClick={saveMaxDevicesForBusiness}>
                        Save Device Limit
                      </Button>
                    </div>

                    <div className="rounded-xl border border-border bg-card/50 px-3 py-3 space-y-3">
                      <div className="text-sm font-semibold">Lifecycle</div>
                      <div className="space-y-2">
                        <Label>Soft-delete reason</Label>
                        <Input
                          value={softDeleteReason}
                          onChange={(e) => setSoftDeleteReason(e.target.value)}
                          placeholder="Fraud / requested cancellation / abuse / etc."
                        />
                      </div>
                      <div className="flex gap-2">
                        <Button
                          variant="destructive"
                          className="flex-1"
                          onClick={softDeleteSelectedBusiness}
                        >
                          Soft Delete
                        </Button>
                        <Button
                          variant="outline"
                          className="flex-1"
                          onClick={restoreSelectedBusiness}
                        >
                          Restore
                        </Button>
                      </div>
                      <div className="text-[11px] text-muted-foreground">
                        Soft-delete is reversible. It suspends access, locks billing,
                        disables users, and disables devices.
                      </div>
                    </div>

                    <div className="grid grid-cols-1 gap-3">
                      <div className="space-y-2">
                        <Label>Kind</Label>
                        <Select
                          value={paymentKind}
                          onValueChange={(v) => setPaymentKind(v as any)}
                        >
                          <SelectTrigger>
                            <SelectValue placeholder="subscription" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="setup">
                              Setup ({`$${selectedPricing.setup}`})
                            </SelectItem>
                            <SelectItem value="subscription">
                              Subscription ({`$${selectedPricing.monthly}`})
                            </SelectItem>
                            <SelectItem value="annual">
                              Annual ({`$${selectedPricing.annual_base}`})
                            </SelectItem>
                            <SelectItem value="reactivation">
                              Reactivation
                            </SelectItem>
                            <SelectItem value="manual">Manual</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>

                      <div className="space-y-2">
                        <Label>Amount</Label>
                        <Input
                          value={paymentAmount}
                          onChange={(e) => setPaymentAmount(e.target.value)}
                          placeholder="5"
                          inputMode="decimal"
                        />
                      </div>

                      <div className="space-y-2">
                        <Label>Months to extend</Label>
                        <Input
                          value={extendMonths}
                          onChange={(e) => setExtendMonths(e.target.value)}
                          placeholder="1"
                          inputMode="numeric"
                        />
                      </div>

                      <div className="flex gap-2">
                        <Button className="flex-1" onClick={recordPaymentAndActivate}>
                          Record + Extend
                        </Button>
                        <Button
                          className="flex-1"
                          variant="outline"
                          onClick={generateReactivationCode}
                        >
                          Generate Code
                        </Button>
                      </div>

                      <div className="text-[11px] text-muted-foreground">
                        Record a payment, then extend paid-through by months (annual
                        auto-fills {selectedPricing.annual_months} months). Grace
                        is enforced automatically.
                      </div>
                    </div>

                    <div className="pt-2 border-t border-border/70">
                      <div className="text-sm font-semibold mb-2">
                        Create Business Admin
                      </div>
                      <div className="space-y-3">
                        <div className="space-y-2">
                          <Label>Full name</Label>
                          <Input
                            value={newAdminFullName}
                            onChange={(e) => setNewAdminFullName(e.target.value)}
                            placeholder="Owner Name"
                          />
                        </div>
                        <div className="space-y-2">
                          <Label>Username</Label>
                          <Input
                            value={newAdminUsername}
                            onChange={(e) => setNewAdminUsername(e.target.value)}
                            placeholder="owner"
                            autoCapitalize="none"
                            autoCorrect="off"
                          />
                        </div>
                        <div className="space-y-2">
                          <Label>Password</Label>
                          <Input
                            value={newAdminPassword}
                            onChange={(e) => setNewAdminPassword(e.target.value)}
                            placeholder="••••••••"
                            type="password"
                          />
                        </div>
                        <Button onClick={createBusinessAdmin}>Create Admin</Button>
                        <div className="text-[11px] text-muted-foreground">
                          This provisions the first admin user for the tenant (they
                          can then add cashiers in Settings).
                        </div>
                      </div>
                    </div>

                    <div className="pt-2 border-t border-border/70">
                      <div className="text-sm font-semibold mb-2">
                        Users ({selectedUsers.length})
                      </div>
                      <div className="space-y-2 max-h-[280px] overflow-auto pos-scrollbar pr-1">
                        {!selectedUsers.length ? (
                          <div className="text-sm text-muted-foreground">
                            No users found.
                          </div>
                        ) : (
                          selectedUsers.map((u: any) => (
                            <div
                              key={u.id}
                              className="rounded-lg border border-border bg-card/60 px-3 py-2 space-y-2"
                            >
                              <div className="flex items-center justify-between gap-2">
                                <div className="min-w-0">
                                  <div className="text-sm font-medium truncate">
                                    {u.full_name || u.username}
                                  </div>
                                  <div className="text-[11px] text-muted-foreground truncate">
                                    {u.username} • {u.role}
                                  </div>
                                </div>
                                <Badge
                                  variant={
                                    u.active === false
                                      ? "destructive"
                                      : "secondary"
                                  }
                                >
                                  {u.active === false ? "disabled" : "active"}
                                </Badge>
                              </div>
                              <div className="flex gap-2">
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="flex-1"
                                  onClick={() => setUserActive(String(u.id), true)}
                                >
                                  Activate
                                </Button>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="flex-1"
                                  onClick={() => setUserActive(String(u.id), false)}
                                >
                                  Deactivate
                                </Button>
                                <Button
                                  size="sm"
                                  variant="destructive"
                                  className="flex-1"
                                  onClick={() => deleteUser(String(u.id))}
                                >
                                  Delete
                                </Button>
                              </div>
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
                          <div className="text-sm text-muted-foreground">
                            No devices registered yet.
                          </div>
                        ) : (
                          selectedDevices.map((d) => (
                            <div
                              key={d.id}
                              className="flex items-center justify-between gap-2 rounded-lg border border-border bg-card/60 px-3 py-2"
                            >
                              <div className="min-w-0">
                                <div className="text-sm font-medium truncate">
                                  {d.platform || "device"}
                                </div>
                                <div className="text-[11px] text-muted-foreground truncate">
                                  {d.device_id}
                                </div>
                                <div className="text-[11px] text-muted-foreground truncate">
                                  Last seen:{" "}
                                  {d.last_seen_at
                                    ? new Date(d.last_seen_at).toLocaleString()
                                    : "—"}
                                </div>
                              </div>
                              <div className="flex items-center gap-2">
                                <Badge
                                  variant={d.active ? "secondary" : "destructive"}
                                >
                                  {d.active ? "active" : "off"}
                                </Badge>
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
                        Device rules are enforced by activation. Deactivate old
                        devices to free a slot.
                      </div>
                    </div>

                    <div className="pt-2 border-t border-border/70">
                      <div className="text-sm font-semibold mb-2">
                        Support Mode (Impersonate)
                      </div>
                      <div className="space-y-3">
                        <div className="space-y-2">
                          <Label>Role</Label>
                          <Select
                            value={impersonationRole}
                            onValueChange={(v) =>
                              setImpersonationRole(
                                (v as any) === "cashier" ? "cashier" : "admin"
                              )
                            }
                          >
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
                        <Button
                          onClick={startImpersonation}
                          disabled={impersonating}
                        >
                          {impersonating ? "Starting..." : "Impersonate Business"}
                        </Button>
                        <div className="text-[11px] text-muted-foreground">
                          This switches your session into the selected tenant. Use
                          the banner to return to Platform Admin.
                        </div>
                      </div>
                    </div>

                    <div className="pt-2 border-t border-border/70">
                      <div className="text-sm font-semibold mb-2">Activity</div>

                      <div className="space-y-2">
                        <div className="text-xs font-semibold text-muted-foreground">
                          Payments (latest)
                        </div>
                        <div className="space-y-2 max-h-[220px] overflow-auto pos-scrollbar pr-1">
                          {!selectedPayments.length ? (
                            <div className="text-sm text-muted-foreground">
                              No payments recorded.
                            </div>
                          ) : (
                            selectedPayments.map((p) => (
                              <div
                                key={p.id}
                                className="flex items-center justify-between gap-2 rounded-lg border border-border bg-card/60 px-3 py-2"
                              >
                                <div className="min-w-0">
                                  <div className="text-sm font-medium truncate">
                                    {p.kind} • {fmtMoney(p.amount)} {p.currency}
                                  </div>
                                  <div className="text-[11px] text-muted-foreground truncate">
                                    {p.created_at
                                      ? new Date(p.created_at).toLocaleString()
                                      : "—"}
                                  </div>
                                </div>
                                <Badge variant="outline">{p.kind}</Badge>
                              </div>
                            ))
                          )}
                        </div>
                      </div>

                      <div className="space-y-2 pt-2">
                        <div className="text-xs font-semibold text-muted-foreground">
                          Reactivation Codes (latest)
                        </div>
                        <div className="space-y-2 max-h-[220px] overflow-auto pos-scrollbar pr-1">
                          {!selectedCodes.length ? (
                            <div className="text-sm text-muted-foreground">
                              No codes issued.
                            </div>
                          ) : (
                            selectedCodes.map((c) => (
                              <div
                                key={c.id}
                                className="flex items-center justify-between gap-2 rounded-lg border border-border bg-card/60 px-3 py-2"
                              >
                                <div className="min-w-0">
                                  <div className="text-sm font-medium truncate">
                                    {c.code_prefix ? `${c.code_prefix}...` : "code"}{" "}
                                    • {c.months} month(s)
                                  </div>
                                  <div className="text-[11px] text-muted-foreground truncate">
                                    Issued:{" "}
                                    {c.issued_at
                                      ? new Date(c.issued_at).toLocaleString()
                                      : "—"}
                                  </div>
                                  {c.redeemed_at ? (
                                    <div className="text-[11px] text-muted-foreground truncate">
                                      Redeemed:{" "}
                                      {new Date(c.redeemed_at).toLocaleString()}
                                    </div>
                                  ) : null}
                                </div>
                                <Badge
                                  variant={
                                    c.redeemed_at
                                      ? "secondary"
                                      : c.active
                                        ? "outline"
                                        : "destructive"
                                  }
                                >
                                  {c.redeemed_at
                                    ? "redeemed"
                                    : c.active
                                      ? "active"
                                      : "off"}
                                </Badge>
                              </div>
                            ))
                          )}
                        </div>
                      </div>

                      <div className="space-y-2 pt-2">
                        <div className="text-xs font-semibold text-muted-foreground">
                          Impersonation (latest)
                        </div>
                        <div className="space-y-2 max-h-[220px] overflow-auto pos-scrollbar pr-1">
                          {!selectedImpersonations.length ? (
                            <div className="text-sm text-muted-foreground">
                              No impersonations yet.
                            </div>
                          ) : (
                            selectedImpersonations.map((a) => (
                              <div
                                key={a.id}
                                className="flex items-center justify-between gap-2 rounded-lg border border-border bg-card/60 px-3 py-2"
                              >
                                <div className="min-w-0">
                                  <div className="text-sm font-medium truncate">
                                    {a.reason}
                                  </div>
                                  <div className="text-[11px] text-muted-foreground truncate">
                                    {a.created_at
                                      ? new Date(a.created_at).toLocaleString()
                                      : "—"}
                                  </div>
                                </div>
                                <Badge
                                  variant={a.ended_at ? "secondary" : "outline"}
                                >
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
        </TabsContent>

        <TabsContent value="billing" className="space-y-4">
          <Card className="shadow-card">
            <CardHeader>
              <div className="flex items-end justify-between gap-2">
                <CardTitle>Billing Ledger</CardTitle>
                <div className="w-[260px] max-w-full">
                  <Input
                    value={billingSearch}
                    onChange={(e) => setBillingSearch(e.target.value)}
                    placeholder="Search tenant / notes"
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
                      <TableHead>Tenant</TableHead>
                      <TableHead>Kind</TableHead>
                      <TableHead className="text-right">Amount</TableHead>
                      <TableHead>Notes</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {!platformPayments.length ? (
                      <TableRow>
                        <TableCell
                          colSpan={5}
                          className="text-sm text-muted-foreground"
                        >
                          {isFetchingPlatformPayments
                            ? "Loading..."
                            : "No payments found (or migration not applied)"}
                        </TableCell>
                      </TableRow>
                    ) : (
                      platformPayments
                        .filter((p) => {
                          const q = String(billingSearch || "").trim().toLowerCase();
                          if (!q) return true;
                          const tenant = String((p as any)?.businesses?.name || "").toLowerCase();
                          const notes = String(p.notes || "").toLowerCase();
                          const kind = String(p.kind || "").toLowerCase();
                          return tenant.includes(q) || notes.includes(q) || kind.includes(q);
                        })
                        .map((p) => (
                          <TableRow key={p.id}>
                            <TableCell className="text-sm">
                              {p.created_at
                                ? new Date(p.created_at).toLocaleString()
                                : "—"}
                            </TableCell>
                            <TableCell className="text-sm font-medium">
                              {(p as any)?.businesses?.name || p.business_id}
                            </TableCell>
                            <TableCell>
                              <Badge variant="outline">{p.kind}</Badge>
                            </TableCell>
                            <TableCell className="text-right font-semibold">
                              ${fmtMoney(p.amount)} {p.currency}
                            </TableCell>
                            <TableCell className="text-sm text-muted-foreground">
                              {p.notes || "—"}
                            </TableCell>
                          </TableRow>
                        ))
                    )}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="feedback" className="space-y-4">
          <Card className="shadow-card">
            <CardHeader>
              <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-3">
                <CardTitle>Feedback Inbox</CardTitle>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-2 md:w-[720px] max-w-full">
                  <Select
                    value={feedbackStatus}
                    onValueChange={(v) => setFeedbackStatus((v as any) || "all")}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Status" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All status</SelectItem>
                      <SelectItem value="new">New</SelectItem>
                      <SelectItem value="triaged">Triaged</SelectItem>
                      <SelectItem value="in_progress">In progress</SelectItem>
                      <SelectItem value="done">Done</SelectItem>
                      <SelectItem value="wont_fix">Won&apos;t fix</SelectItem>
                    </SelectContent>
                  </Select>

                  <Select
                    value={feedbackType}
                    onValueChange={(v) => setFeedbackType((v as any) || "all")}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Type" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All types</SelectItem>
                      <SelectItem value="bug">Bug</SelectItem>
                      <SelectItem value="feature">Feature</SelectItem>
                      <SelectItem value="review">Review</SelectItem>
                    </SelectContent>
                  </Select>

                  <Select
                    value={feedbackSeverity}
                    onValueChange={(v) =>
                      setFeedbackSeverity((v as any) || "all")
                    }
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Severity" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All severity</SelectItem>
                      <SelectItem value="high">High</SelectItem>
                      <SelectItem value="medium">Medium</SelectItem>
                      <SelectItem value="low">Low</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <div className="rounded-xl border border-border overflow-hidden">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>When</TableHead>
                      <TableHead>Tenant</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Title</TableHead>
                      <TableHead>Severity</TableHead>
                      <TableHead className="text-right">Action</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {!platformFeedback.length ? (
                      <TableRow>
                        <TableCell
                          colSpan={7}
                          className="text-sm text-muted-foreground"
                        >
                          {isFetchingPlatformFeedback
                            ? "Loading..."
                            : "No feedback found (or migration not applied)"}
                        </TableCell>
                      </TableRow>
                    ) : (
                      platformFeedback.map((f) => (
                        <TableRow key={f.id}>
                          <TableCell className="text-sm">
                            {f.created_at
                              ? new Date(f.created_at).toLocaleString()
                              : "—"}
                          </TableCell>
                          <TableCell className="text-sm font-medium">
                            {(f as any)?.businesses?.name || f.business_id}
                          </TableCell>
                          <TableCell>
                            <Badge variant="outline">
                              {f.type}
                              {f.type === "review" && f.rating
                                ? ` (${f.rating}/5)`
                                : ""}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            <Badge
                              variant={
                                f.status === "new"
                                  ? "destructive"
                                  : f.status === "in_progress"
                                    ? "outline"
                                    : "secondary"
                              }
                            >
                              {f.status}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-sm">
                            <div className="font-semibold">{f.title}</div>
                            <div className="text-[11px] text-muted-foreground line-clamp-2">
                              {f.message}
                            </div>
                          </TableCell>
                          <TableCell>
                            <Badge
                              variant={
                                f.severity === "high"
                                  ? "destructive"
                                  : f.severity === "medium"
                                    ? "outline"
                                    : "secondary"
                              }
                            >
                              {f.severity}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-right">
                            <Select
                              value={f.status}
                              onValueChange={(v) =>
                                updateFeedbackStatus(f, v as any)
                              }
                            >
                              <SelectTrigger className="h-9 w-[160px] ml-auto">
                                <SelectValue placeholder="Update" />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="new">New</SelectItem>
                                <SelectItem value="triaged">Triaged</SelectItem>
                                <SelectItem value="in_progress">
                                  In progress
                                </SelectItem>
                                <SelectItem value="done">Done</SelectItem>
                                <SelectItem value="wont_fix">
                                  Won&apos;t fix
                                </SelectItem>
                              </SelectContent>
                            </Select>
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="pricing" className="space-y-4">
          <Card className="shadow-card">
            <CardHeader>
              <CardTitle>Global Pricing (Editable)</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="text-sm text-muted-foreground">
                Stored in <span className="font-mono">pricing_plans</span>. Used by
                the platform console and marketing site. (Defaults apply if the
                table isn&apos;t migrated yet.)
              </div>

              <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                {(["business_system", "app_only"] as PlanType[]).map((pt) => {
                  const p = pricingDraft[pt];
                  return (
                    <Card key={pt} className="shadow-card">
                      <CardHeader>
                        <CardTitle>
                          {pt === "business_system" ? "Business System" : "App Only"}
                        </CardTitle>
                      </CardHeader>
                      <CardContent className="grid grid-cols-2 gap-3">
                        <div className="space-y-2">
                          <Label>Included devices</Label>
                          <Input
                            value={String(p.included_devices)}
                            onChange={(e) =>
                              setPricingDraft((d) => ({
                                ...d,
                                [pt]: {
                                  ...d[pt],
                                  included_devices: toNum(
                                    e.target.value,
                                    d[pt].included_devices
                                  ),
                                },
                              }))
                            }
                            inputMode="numeric"
                          />
                        </div>
                        <div className="space-y-2">
                          <Label>Annual months</Label>
                          <Input
                            value={String(p.annual_months)}
                            onChange={(e) =>
                              setPricingDraft((d) => ({
                                ...d,
                                [pt]: {
                                  ...d[pt],
                                  annual_months: toNum(
                                    e.target.value,
                                    d[pt].annual_months
                                  ),
                                },
                              }))
                            }
                            inputMode="numeric"
                          />
                        </div>

                        <div className="space-y-2">
                          <Label>Setup base ($)</Label>
                          <Input
                            value={String(p.setup_base)}
                            onChange={(e) =>
                              setPricingDraft((d) => ({
                                ...d,
                                [pt]: {
                                  ...d[pt],
                                  setup_base: toNum(
                                    e.target.value,
                                    d[pt].setup_base
                                  ),
                                },
                              }))
                            }
                            inputMode="decimal"
                          />
                        </div>
                        <div className="space-y-2">
                          <Label>Setup per extra ($)</Label>
                          <Input
                            value={String(p.setup_per_extra)}
                            onChange={(e) =>
                              setPricingDraft((d) => ({
                                ...d,
                                [pt]: {
                                  ...d[pt],
                                  setup_per_extra: toNum(
                                    e.target.value,
                                    d[pt].setup_per_extra
                                  ),
                                },
                              }))
                            }
                            inputMode="decimal"
                          />
                        </div>

                        <div className="space-y-2">
                          <Label>Monthly base ($)</Label>
                          <Input
                            value={String(p.monthly_base)}
                            onChange={(e) =>
                              setPricingDraft((d) => ({
                                ...d,
                                [pt]: {
                                  ...d[pt],
                                  monthly_base: toNum(
                                    e.target.value,
                                    d[pt].monthly_base
                                  ),
                                },
                              }))
                            }
                            inputMode="decimal"
                          />
                        </div>
                        <div className="space-y-2">
                          <Label>Monthly per extra ($)</Label>
                          <Input
                            value={String(p.monthly_per_extra)}
                            onChange={(e) =>
                              setPricingDraft((d) => ({
                                ...d,
                                [pt]: {
                                  ...d[pt],
                                  monthly_per_extra: toNum(
                                    e.target.value,
                                    d[pt].monthly_per_extra
                                  ),
                                },
                              }))
                            }
                            inputMode="decimal"
                          />
                        </div>

                        <div className="space-y-2 col-span-2">
                          <Label>Annual base ($)</Label>
                          <Input
                            value={String(p.annual_base)}
                            onChange={(e) =>
                              setPricingDraft((d) => ({
                                ...d,
                                [pt]: {
                                  ...d[pt],
                                  annual_base: toNum(
                                    e.target.value,
                                    d[pt].annual_base
                                  ),
                                },
                              }))
                            }
                            inputMode="decimal"
                          />
                        </div>

                        <div className="col-span-2 rounded-xl border border-border bg-card/50 px-3 py-3">
                          {(() => {
                            const preview = computePlanPricing(pt, 4, pricingDraft);
                            return (
                              <div className="text-xs text-muted-foreground">
                                Preview (4 devices): Setup ${preview.setup} • Monthly $
                                {preview.monthly} • Annual ${preview.annual_base}
                              </div>
                            );
                          })()}
                        </div>
                      </CardContent>
                    </Card>
                  );
                })}
              </div>

              <div className="flex flex-col md:flex-row gap-2 md:items-center md:justify-between">
                <div className="text-xs text-muted-foreground">
                  Editing pricing here updates onboarding previews and the public
                  pricing page on your marketing site.
                </div>
                <div className="flex gap-2">
                  <Button variant="outline" onClick={() => setPricingDraft(pricingPlans)}>
                    Reset
                  </Button>
                  <Button onClick={savePricing}>Save Pricing</Button>
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}

