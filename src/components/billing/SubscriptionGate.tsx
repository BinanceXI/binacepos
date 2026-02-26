import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { usePOS } from "@/contexts/POSContext";
import { BRAND } from "@/lib/brand";
import { secureTime } from "@/lib/secureTime";
import { clearClientIndexedDb, clearClientStorage } from "@/lib/sessionCleanup";
import { toast } from "sonner";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { computeBusinessLicenseState, type BusinessLicenseState } from "@/lib/commercialization";

type BillingRow = {
  business_id: string;
  paid_through: string | null;
  grace_days: number;
  locked_override: boolean;
  currency: string;
  trial_started_at: string | null;
  trial_ends_at: string | null;
  activated_at: string | null;
};

type AccessState = BusinessLicenseState;

type PlatformSettingsRow = {
  trial_days: number;
  payment_provider: string;
  payment_instructions: string;
  ecocash_number: string | null;
  ecocash_name: string | null;
  support_contact: string | null;
};

type ActivationRequestRow = {
  id: string;
  status: "pending" | "approved" | "rejected" | "cancelled" | string;
  created_at: string;
  reviewed_at: string | null;
  admin_note: string | null;
};

type BillingCache = {
  billing: BillingRow | null;
  businessStatus: string | null;
  fetchedAt: string; // ISO
};

const BILLING_CACHE_PREFIX = "binancexi_billing_cache_v1:";
const DEMO_EXPIRES_KEY = "binancexi_demo_expires_at";
const ACTIVATION_BYPASS_ROLES = new Set(["platform_admin", "master_admin", "super_admin"]);
const TEMP_DISABLE_ACTIVATION_LOCK = true;

function normalizeRole(role: unknown) {
  return String(role || "").trim().toLowerCase();
}

function isActivationBypassRole(role: unknown) {
  return ACTIVATION_BYPASS_ROLES.has(normalizeRole(role));
}

function getBillingCacheKey(businessId: string) {
  return `${BILLING_CACHE_PREFIX}${businessId}`;
}

function safeJSONParse<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function loadBillingCache(businessId: string): BillingCache | null {
  try {
    const raw = localStorage.getItem(getBillingCacheKey(businessId));
    const parsed = safeJSONParse<BillingCache>(raw);
    if (!parsed) return null;
    if (!parsed.fetchedAt) return null;
    return parsed;
  } catch {
    return null;
  }
}

function saveBillingCache(businessId: string, cache: BillingCache) {
  try {
    localStorage.setItem(getBillingCacheKey(businessId), JSON.stringify(cache));
  } catch {
    // ignore
  }
}

function computeState(
  b: BillingRow | null,
  businessStatus: string | null,
  nowMs: number
): AccessState {
  return computeBusinessLicenseState(businessStatus, b || null, nowMs);
}

export function SubscriptionGate({ children }: { children: React.ReactNode }) {
  const qc = useQueryClient();
  const { currentUser, setCurrentUser } = usePOS();

  const role = (currentUser as any)?.role;
  const roleNormalized = normalizeRole(role);
  const roleResolved = !currentUser || roleNormalized.length > 0;
  const bypassActivationGate = isActivationBypassRole(role);
  const businessId = String((currentUser as any)?.business_id || "").trim() || null;
  const offline = typeof navigator !== "undefined" && navigator.onLine === false;

  const [payerName, setPayerName] = useState("");
  const [payerPhone, setPayerPhone] = useState("");
  const [paymentReference, setPaymentReference] = useState("");
  const [requestMessage, setRequestMessage] = useState("");
  const [requestingActivation, setRequestingActivation] = useState(false);
  const [clockTick, setClockTick] = useState(0);
  const [forcingDemoExpiry, setForcingDemoExpiry] = useState(false);

  // Enforce lock as time passes even if the page stays open (especially offline).
  useEffect(() => {
    const t = window.setInterval(() => setClockTick((n) => (n + 1) % 1_000_000), 30_000);
    return () => window.clearInterval(t);
  }, []);

  const { data, isFetching, error, refetch } = useQuery({
    queryKey: ["billing", businessId],
    queryFn: async () => {
      if (!businessId) return { billing: null as BillingRow | null, businessStatus: null as string | null };

      const cached = loadBillingCache(businessId);
      if (offline && cached) return cached;

      try {
        const [{ data: billing, error: billErr }, { data: biz, error: bizErr }] = await Promise.all([
          supabase
            .from("business_billing")
            .select(
              "business_id, paid_through, grace_days, locked_override, currency, trial_started_at, trial_ends_at, activated_at"
            )
            .eq("business_id", businessId)
            .maybeSingle(),
          supabase.from("businesses").select("id, status").eq("id", businessId).maybeSingle(),
        ]);

        if (billErr) throw billErr;
        if (bizErr) throw bizErr;

        const out: BillingCache = {
          billing: (billing as any) || null,
          businessStatus: (biz as any)?.status ? String((biz as any).status) : null,
          fetchedAt: new Date().toISOString(),
        };
        saveBillingCache(businessId, out);
        return out;
      } catch (e) {
        if (cached) return cached;
        // No cache: lock by default (offline or unknown).
        return {
          billing: null,
          businessStatus: null,
          fetchedAt: new Date().toISOString(),
        } satisfies BillingCache;
      }
    },
    enabled: !!currentUser && roleResolved && !bypassActivationGate,
    staleTime: 10_000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: true,
  });

  const { data: platformSettings } = useQuery({
    queryKey: ["platformSettings", "billingGate"],
    queryFn: async () => {
      try {
        const { data, error } = await supabase
          .from("platform_settings")
          .select(
            "trial_days, payment_provider, payment_instructions, ecocash_number, ecocash_name, support_contact"
          )
          .eq("id", true)
          .maybeSingle();
        if (error) throw error;
        return (data as any) as PlatformSettingsRow | null;
      } catch {
        return null;
      }
    },
    enabled: !!currentUser && roleResolved && !bypassActivationGate,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  const { data: latestActivationRequest, refetch: refetchActivationRequest } = useQuery({
    queryKey: ["activationRequests", "latest", businessId],
    queryFn: async () => {
      if (!businessId) return null as ActivationRequestRow | null;
      try {
        const { data, error } = await supabase
          .from("activation_requests")
          .select("id, status, created_at, reviewed_at, admin_note")
          .eq("business_id", businessId)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (error) throw error;
        return (data as any) as ActivationRequestRow | null;
      } catch {
        return null;
      }
    },
    enabled: !!businessId && roleResolved && !bypassActivationGate,
    staleTime: 10_000,
    refetchOnWindowFocus: false,
  });

  // Note: `clockTick` exists only to force periodic re-renders so time-based locking applies even
  // if the app stays open for hours.
  // eslint-disable-next-line @typescript-eslint/no-unused-expressions
  clockTick;
  const nowMs = secureTime.timestamp();
  let demoExpiresAtRaw: string | null = null;
  if (typeof window !== "undefined") {
    try {
      demoExpiresAtRaw = localStorage.getItem(DEMO_EXPIRES_KEY);
    } catch {
      demoExpiresAtRaw = null;
    }
  }
  const demoExpiresAtMs = demoExpiresAtRaw ? Date.parse(demoExpiresAtRaw) : NaN;
  const demoExpired = Number.isFinite(demoExpiresAtMs) ? nowMs >= demoExpiresAtMs : false;
  const state: AccessState = computeState(data?.billing ?? null, data?.businessStatus ?? null, nowMs);

  useEffect(() => {
    if (!currentUser) return;
    if (!roleResolved) return;
    if (bypassActivationGate) return;
    if (!demoExpired) return;
    if (forcingDemoExpiry) return;

    let cancelled = false;
    setForcingDemoExpiry(true);

    const run = async () => {
      toast.error("Demo expired. Start a new demo session.");

      try {
        await supabase.auth.signOut();
      } catch {
        // ignore
      }

      clearClientStorage({ includeDemoExpires: true });
      await clearClientIndexedDb();

      if (cancelled) return;

      setCurrentUser(null);
      qc.clear();
      window.location.assign("/?demo=1");
    };

    void run();

    return () => {
      cancelled = true;
    };
  }, [
    currentUser,
    currentUser?.id,
    roleResolved,
    bypassActivationGate,
    demoExpired,
    forcingDemoExpiry,
    qc,
    setCurrentUser,
  ]);

  const gateDecision =
    bypassActivationGate
      ? "bypass_admin_role"
      : TEMP_DISABLE_ACTIVATION_LOCK && state === "locked"
        ? "allow_locked_temp_bypass"
      : !roleResolved
        ? "wait_role_resolution"
        : demoExpired || forcingDemoExpiry
          ? "demo_expired"
          : !businessId
            ? "missing_business_id"
            : isFetching
              ? "loading"
              : error && !data?.billing
                ? "error"
                : state !== "locked"
                  ? "allow"
                  : "locked";

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    console.debug("[activation-gate]", {
      role: roleNormalized || null,
      businessId,
      paidThrough: data?.billing?.paid_through ?? null,
      lockedOverride: data?.billing?.locked_override ?? null,
      businessStatus: data?.businessStatus ?? null,
      accessState: state,
      finalDecision: gateDecision,
    });
  }, [
    roleNormalized,
    businessId,
    data?.billing?.paid_through,
    data?.billing?.locked_override,
    data?.businessStatus,
    state,
    gateDecision,
  ]);

  // Platform admin is never subscription-gated.
  if (bypassActivationGate) return <>{children}</>;

  if (!roleResolved) {
    return (
      <div className="min-h-[70vh] flex items-center justify-center p-6">
        <div className="text-sm text-muted-foreground">Resolving access...</div>
      </div>
    );
  }

  if (demoExpired || forcingDemoExpiry) {
    return (
      <div className="min-h-[70vh] flex items-center justify-center p-6">
        <Card className="max-w-lg w-full shadow-card">
          <CardHeader>
            <CardTitle>Demo Expired</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="text-sm text-muted-foreground">
              Demo expired. Start a new demo session.
            </div>
            <Button
              className="w-full"
              onClick={() => window.location.assign("/?demo=1")}
              disabled={forcingDemoExpiry}
            >
              {forcingDemoExpiry ? "Signing out..." : "Start New Demo"}
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!businessId) {
    return (
      <div className="min-h-[70vh] flex items-center justify-center p-6">
        <Card className="max-w-lg w-full shadow-card">
          <CardHeader>
            <CardTitle>Business Not Set</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            This account is missing a `business_id`. Ask BinanceXI POS admin to fix your user profile.
          </CardContent>
        </Card>
      </div>
    );
  }

  if (isFetching) {
    return (
      <div className="min-h-[70vh] flex items-center justify-center p-6">
        <div className="text-sm text-muted-foreground">Checking subscription...</div>
      </div>
    );
  }

  // If we have no usable data and the query failed, show a retry.
  if (error && !data?.billing) {
    return (
      <div className="min-h-[70vh] flex items-center justify-center p-6">
        <Card className="max-w-lg w-full shadow-card">
          <CardHeader>
            <CardTitle>Subscription Check Failed</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="text-sm text-muted-foreground">
              Could not verify subscription status. Please try again.
            </div>
            <Button onClick={() => refetch()}>Retry</Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (state !== "locked" || TEMP_DISABLE_ACTIVATION_LOCK) {
    // Optional grace banner
    return (
      <div className="space-y-4">
        {state === "locked" && TEMP_DISABLE_ACTIVATION_LOCK && (
          <div className="p-3 md:p-4">
            <div className="rounded-xl border border-red-500/25 bg-red-500/10 px-3 py-2 text-sm flex items-center justify-between gap-2">
              <div>
                <span className="font-semibold">Activation lock bypassed:</span> access is temporarily allowed.
              </div>
              <Badge variant="outline">billing lock bypass</Badge>
            </div>
          </div>
        )}
        {offline && (
          <div className="p-3 md:p-4">
            <div className="rounded-xl border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-sm">
              <span className="font-semibold">Offline:</span> using last known subscription status.
            </div>
          </div>
        )}
        {state === "trial" && (
          <div className="p-3 md:p-4">
            <div className="rounded-xl border border-blue-500/25 bg-blue-500/10 px-3 py-2 text-sm flex items-center justify-between gap-2">
              <div>
                <span className="font-semibold">Trial active:</span> you are in the free trial period.
              </div>
              <Badge variant="outline">trial</Badge>
            </div>
          </div>
        )}
        {state === "grace" && (
          <div className="p-3 md:p-4">
            <div className="rounded-xl border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-sm flex items-center justify-between gap-2">
              <div>
                <span className="font-semibold">Grace period:</span> payment is overdue.
              </div>
              <Badge variant="outline">grace</Badge>
            </div>
          </div>
        )}
        {children}
      </div>
    );
  }

  const paidThrough = data?.billing?.paid_through ? new Date(data.billing.paid_through) : null;
  const trialEndsAt = data?.billing?.trial_ends_at ? new Date(data.billing.trial_ends_at) : null;
  const paymentProvider =
    String(platformSettings?.payment_provider || "").trim() || "EcoCash";
  const paymentInstructions =
    String(platformSettings?.payment_instructions || "").trim() ||
    `Pay via ${paymentProvider} and tap "I Have Paid" to send an activation request for review.`;

  const submitActivationRequest = async () => {
    if (offline) return toast.error("Connect to the internet to send activation request");
    if (!businessId) return toast.error("Missing business");
    if (latestActivationRequest?.status === "pending") {
      return toast.error("An activation request is already pending review");
    }

    setRequestingActivation(true);
    try {
      const { error } = await supabase.from("activation_requests").insert({
        business_id: businessId,
        payment_method: "ecocash",
        payer_name: String(payerName || "").trim() || null,
        payer_phone: String(payerPhone || "").trim() || null,
        payment_reference: String(paymentReference || "").trim() || null,
        message: String(requestMessage || "").trim() || null,
        months_requested: 1,
      } as any);
      if (error) throw error;

      toast.success("Activation request sent. Admin will review after payment verification.");
      setPayerName("");
      setPayerPhone("");
      setPaymentReference("");
      setRequestMessage("");
      await refetchActivationRequest();
      await qc.invalidateQueries({ queryKey: ["billing", businessId] });
    } catch (e: any) {
      const msg = String(e?.message || "");
      if (msg.toLowerCase().includes("duplicate key")) {
        toast.error("A pending activation request already exists for this business.");
      } else {
        toast.error(msg || "Failed to send activation request");
      }
    } finally {
      setRequestingActivation(false);
    }
  };

  return (
    <div className="min-h-[70vh] flex items-center justify-center p-6">
      <Card className="max-w-lg w-full shadow-card">
        <CardHeader>
          <CardTitle>Activation Required</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="text-sm text-muted-foreground">
            {BRAND.name} is locked for this business. Pay using the instructions below, then send an activation request.
          </div>

          {trialEndsAt && !Number.isNaN(trialEndsAt.getTime()) && (
            <div className="text-xs text-muted-foreground">
              Trial ended: {trialEndsAt.toLocaleDateString()}
            </div>
          )}

          {paidThrough && !Number.isNaN(paidThrough.getTime()) && (
            <div className="text-xs text-muted-foreground">
              Last paid through: {paidThrough.toLocaleDateString()}
            </div>
          )}

          {offline && (
            <div className="text-xs text-amber-600">
              You are offline. Connect to the internet to send an activation request.
            </div>
          )}

          <div className="rounded-xl border border-border bg-card/50 px-3 py-3 space-y-2">
            <div className="text-sm font-semibold">{paymentProvider} Payment Instructions</div>
            {platformSettings?.ecocash_number ? (
              <div className="text-sm">
                Number: <span className="font-semibold">{platformSettings.ecocash_number}</span>
              </div>
            ) : null}
            {platformSettings?.ecocash_name ? (
              <div className="text-sm">
                Name: <span className="font-semibold">{platformSettings.ecocash_name}</span>
              </div>
            ) : null}
            <div className="text-sm text-muted-foreground whitespace-pre-wrap">
              {paymentInstructions}
            </div>
            {platformSettings?.support_contact ? (
              <div className="text-xs text-muted-foreground">
                Support: {platformSettings.support_contact}
              </div>
            ) : null}
          </div>

          {latestActivationRequest ? (
            <div className="rounded-xl border border-border bg-card/50 px-3 py-3 space-y-1">
              <div className="flex items-center justify-between gap-2">
                <div className="text-sm font-semibold">Latest Request</div>
                <Badge
                  variant={
                    latestActivationRequest.status === "approved"
                      ? "secondary"
                      : latestActivationRequest.status === "pending"
                        ? "outline"
                        : "destructive"
                  }
                >
                  {latestActivationRequest.status}
                </Badge>
              </div>
              <div className="text-xs text-muted-foreground">
                Sent: {new Date(latestActivationRequest.created_at).toLocaleString()}
              </div>
              {latestActivationRequest.admin_note ? (
                <div className="text-xs text-muted-foreground whitespace-pre-wrap">
                  Admin note: {latestActivationRequest.admin_note}
                </div>
              ) : null}
            </div>
          ) : null}

          <div className="space-y-2">
            <Label>Payer name (optional)</Label>
            <Input
              value={payerName}
              onChange={(e) => setPayerName(e.target.value)}
              placeholder="Tendai Nashe"
            />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            <div className="space-y-2">
              <Label>EcoCash number (optional)</Label>
              <Input
                value={payerPhone}
                onChange={(e) => setPayerPhone(e.target.value)}
                placeholder="0772..."
              />
            </div>
            <div className="space-y-2">
              <Label>Payment reference (optional)</Label>
              <Input
                value={paymentReference}
                onChange={(e) => setPaymentReference(e.target.value)}
                placeholder="EcoCash ref"
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label>Message (optional)</Label>
            <Textarea
              value={requestMessage}
              onChange={(e) => setRequestMessage(e.target.value)}
              placeholder="I paid and need activation for this business."
              rows={3}
            />
          </div>

          <div className="flex gap-2">
            <Button
              className="flex-1"
              onClick={submitActivationRequest}
              disabled={requestingActivation || latestActivationRequest?.status === "pending"}
            >
              {requestingActivation ? "Sending..." : "I Have Paid"}
            </Button>
            <Button
              className="flex-1"
              variant="outline"
              onClick={() => {
                void refetch();
                void refetchActivationRequest();
              }}
              disabled={requestingActivation}
            >
              Refresh
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
