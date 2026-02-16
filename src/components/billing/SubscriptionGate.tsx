import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { usePOS } from "@/contexts/POSContext";
import { BRAND } from "@/lib/brand";
import { toast } from "sonner";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";

type BillingRow = {
  business_id: string;
  paid_through: string;
  grace_days: number;
  locked_override: boolean;
  currency: string;
};

type AccessState = "active" | "grace" | "locked";

type BillingCache = {
  billing: BillingRow | null;
  businessStatus: string | null;
  fetchedAt: string; // ISO
};

const BILLING_CACHE_PREFIX = "binancexi_billing_cache_v1:";

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

function computeState(b: BillingRow | null, businessStatus: string | null): AccessState {
  if (!b) return "locked";
  if (businessStatus === "suspended") return "locked";
  if (b.locked_override) return "locked";

  const paid = new Date(b.paid_through);
  if (Number.isNaN(paid.getTime())) return "locked";

  if (Date.now() <= paid.getTime()) return "active";
  const graceEnd = paid.getTime() + (Number(b.grace_days || 0) || 0) * 24 * 60 * 60 * 1000;
  if (Date.now() <= graceEnd) return "grace";
  return "locked";
}

export function SubscriptionGate({ children }: { children: React.ReactNode }) {
  const qc = useQueryClient();
  const { currentUser } = usePOS();

  const role = (currentUser as any)?.role;
  const businessId = String((currentUser as any)?.business_id || "").trim() || null;
  const offline = typeof navigator !== "undefined" && navigator.onLine === false;

  const [code, setCode] = useState("");
  const [redeeming, setRedeeming] = useState(false);
  const [clockTick, setClockTick] = useState(0);

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
            .select("business_id, paid_through, grace_days, locked_override, currency")
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
    enabled: role !== "platform_admin" && !!currentUser,
    staleTime: 10_000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: true,
  });

  // Note: `clockTick` exists only to force periodic re-renders so time-based locking applies even
  // if the app stays open for hours.
  // eslint-disable-next-line @typescript-eslint/no-unused-expressions
  clockTick;
  const state: AccessState = computeState(data?.billing ?? null, data?.businessStatus ?? null);

  // Platform admin is never subscription-gated.
  if (role === "platform_admin") return <>{children}</>;

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

  if (state !== "locked") {
    // Optional grace banner
    return (
      <div className="space-y-4">
        {offline && (
          <div className="p-3 md:p-4">
            <div className="rounded-xl border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-sm">
              <span className="font-semibold">Offline:</span> using last known subscription status.
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

  const redeem = async () => {
    if (offline) return toast.error("Connect to the internet to activate");
    const c = String(code || "").trim();
    if (!c) return toast.error("Enter a reactivation code");

    setRedeeming(true);
    try {
      const { data: out, error: rpcErr } = await supabase.rpc("redeem_reactivation_code", { p_code: c });
      if (rpcErr) throw rpcErr;

      setCode("");
      toast.success("Reactivated");
      await qc.invalidateQueries({ queryKey: ["billing", businessId] });
      await qc.invalidateQueries(); // best-effort: refresh everything
      return out;
    } catch (e: any) {
      toast.error(e?.message || "Invalid code");
    } finally {
      setRedeeming(false);
    }
  };

  return (
    <div className="min-h-[70vh] flex items-center justify-center p-6">
      <Card className="max-w-lg w-full shadow-card">
        <CardHeader>
          <CardTitle>Subscription Locked</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="text-sm text-muted-foreground">
            {BRAND.name} is locked for this business. Contact BinanceXI POS admin for a reactivation code.
          </div>

          {paidThrough && !Number.isNaN(paidThrough.getTime()) && (
            <div className="text-xs text-muted-foreground">
              Paid through: {paidThrough.toLocaleDateString()}
            </div>
          )}

          {offline && (
            <div className="text-xs text-amber-600">
              You are offline. Connect to the internet to activate with a code.
            </div>
          )}

          <div className="space-y-2">
            <Label>Reactivation code</Label>
            <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="XXXX-XXXX..." autoCapitalize="characters" />
          </div>

          <div className="flex gap-2">
            <Button className="flex-1" onClick={redeem} disabled={redeeming}>
              {redeeming ? "Activating..." : "Activate"}
            </Button>
            <Button className="flex-1" variant="outline" onClick={() => refetch()} disabled={redeeming}>
              Refresh
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
