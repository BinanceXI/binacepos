import { useQuery } from "@tanstack/react-query";

import { supabase } from "@/lib/supabase";
import { fmtMoney } from "@/lib/commercialization";

import { PlatformPageHeader } from "@/components/platform/PlatformPageHeader";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

type ActivityRow = {
  id: string;
  created_at: string;
  action: string;
  business_id: string | null;
  target_type: string | null;
  target_id: string | null;
  details: any;
  businesses?: { name?: string | null } | null;
};

type ImpersonationRow = {
  id: string;
  reason: string;
  business_id: string;
  created_at: string;
  ended_at: string | null;
};

type PaymentRow = {
  id: string;
  business_id: string;
  amount: number;
  currency: string;
  kind: string;
  created_at: string;
  notes: string | null;
  businesses?: { name?: string | null } | null;
};

export function PlatformAuditLogsPage() {
  const { data: activityLogs = [] } = useQuery({
    queryKey: ["platform", "auditLogs", "activity"],
    queryFn: async () => {
      try {
        const { data, error } = await supabase
          .from("platform_activity_logs")
          .select("id, created_at, action, business_id, target_type, target_id, details, businesses(name)")
          .order("created_at", { ascending: false })
          .limit(200);
        if (error) throw error;
        return (data || []) as unknown as ActivityRow[];
      } catch {
        return [] as ActivityRow[];
      }
    },
    staleTime: 10_000,
    refetchOnWindowFocus: false,
  });

  const { data: impersonationLogs = [] } = useQuery({
    queryKey: ["platform", "auditLogs", "impersonation"],
    queryFn: async () => {
      try {
        const { data, error } = await supabase
          .from("impersonation_audit")
          .select("id, reason, business_id, created_at, ended_at")
          .order("created_at", { ascending: false })
          .limit(100);
        if (error) throw error;
        return (data || []) as unknown as ImpersonationRow[];
      } catch {
        return [] as ImpersonationRow[];
      }
    },
    staleTime: 10_000,
    refetchOnWindowFocus: false,
  });

  const { data: paymentLogs = [] } = useQuery({
    queryKey: ["platform", "auditLogs", "payments"],
    queryFn: async () => {
      try {
        const { data, error } = await supabase
          .from("billing_payments")
          .select("id, business_id, amount, currency, kind, created_at, notes, businesses(name)")
          .order("created_at", { ascending: false })
          .limit(100);
        if (error) throw error;
        return (data || []) as unknown as PaymentRow[];
      } catch {
        return [] as PaymentRow[];
      }
    },
    staleTime: 10_000,
    refetchOnWindowFocus: false,
  });

  return (
    <div className="p-4 md:p-6 space-y-4">
      <PlatformPageHeader
        title="Audit Logs"
        subtitle="Platform actions, impersonation sessions, and billing entries for operational review."
      />

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
        <Card className="shadow-card xl:col-span-2">
          <CardHeader>
            <CardTitle>Platform Activity</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2 max-h-[520px] overflow-auto pos-scrollbar pr-1">
              {!activityLogs.length ? (
                <div className="text-sm text-muted-foreground">
                  No platform activity logs found (migration may not be applied yet).
                </div>
              ) : (
                activityLogs.map((row) => (
                  <div
                    key={row.id}
                    className="rounded-xl border border-border px-3 py-2 space-y-1"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-sm font-semibold">{row.action}</div>
                      <Badge variant="outline">
                        {new Date(row.created_at).toLocaleString()}
                      </Badge>
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {row.businesses?.name || row.business_id || "platform"}{" "}
                      {row.target_type ? `• ${row.target_type}` : ""}
                      {row.target_id ? ` • ${row.target_id}` : ""}
                    </div>
                    {row.details ? (
                      <pre className="text-[11px] text-muted-foreground whitespace-pre-wrap break-words rounded-lg bg-muted/40 p-2 overflow-x-auto">
                        {JSON.stringify(row.details, null, 2)}
                      </pre>
                    ) : null}
                  </div>
                ))
              )}
            </div>
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card className="shadow-card">
            <CardHeader>
              <CardTitle>Impersonation</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-2 max-h-[250px] overflow-auto pos-scrollbar pr-1">
                {!impersonationLogs.length ? (
                  <div className="text-sm text-muted-foreground">No impersonation logs.</div>
                ) : (
                  impersonationLogs.map((row) => (
                    <div key={row.id} className="rounded-xl border border-border px-3 py-2">
                      <div className="flex items-center justify-between gap-2">
                        <div className="text-sm font-semibold truncate">{row.reason}</div>
                        <Badge variant={row.ended_at ? "secondary" : "outline"}>
                          {row.ended_at ? "ended" : "active"}
                        </Badge>
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {new Date(row.created_at).toLocaleString()}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </CardContent>
          </Card>

          <Card className="shadow-card">
            <CardHeader>
              <CardTitle>Recent Payments</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-2 max-h-[250px] overflow-auto pos-scrollbar pr-1">
                {!paymentLogs.length ? (
                  <div className="text-sm text-muted-foreground">No billing payments found.</div>
                ) : (
                  paymentLogs.map((p) => (
                    <div key={p.id} className="rounded-xl border border-border px-3 py-2">
                      <div className="flex items-center justify-between gap-2">
                        <div className="text-sm font-semibold">
                          ${fmtMoney(p.amount)} {p.currency}
                        </div>
                        <Badge variant="outline">{p.kind}</Badge>
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {(p.businesses?.name || p.business_id) ?? "—"}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {new Date(p.created_at).toLocaleString()}
                      </div>
                      {p.notes ? (
                        <div className="text-xs text-muted-foreground line-clamp-2">{p.notes}</div>
                      ) : null}
                    </div>
                  ))
                )}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

export default PlatformAuditLogsPage;
