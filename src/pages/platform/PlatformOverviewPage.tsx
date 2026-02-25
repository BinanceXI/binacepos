import { useMemo } from "react";

import { PlatformPageHeader } from "@/components/platform/PlatformPageHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { fmtMoney } from "@/lib/commercialization";
import { usePlatformCommercialMetrics } from "@/pages/platform/usePlatformCommercialMetrics";

export function PlatformOverviewPage() {
  const { metrics, isFetching, refetchAll } = usePlatformCommercialMetrics();

  const recentBusinesses = useMemo(
    () =>
      [...metrics.businesses]
        .sort((a, b) => Date.parse(b.created_at || "") - Date.parse(a.created_at || ""))
        .slice(0, 8),
    [metrics.businesses]
  );

  return (
    <div className="p-4 md:p-6 space-y-4">
      <PlatformPageHeader
        title="Overview"
        subtitle="Commercial health snapshot: trials, activations, locks, revenue estimate, and device distribution."
        right={
          <Button variant="outline" onClick={() => void refetchAll()}>
            Refresh
          </Button>
        }
      />

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-5 gap-4">
        <Card className="shadow-card">
          <CardHeader>
            <CardTitle>Total Businesses</CardTitle>
          </CardHeader>
          <CardContent className="text-3xl font-extrabold">
            {isFetching ? "…" : metrics.total}
          </CardContent>
        </Card>

        <Card className="shadow-card">
          <CardHeader>
            <CardTitle>License States</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            <div>Active: <span className="font-semibold">{metrics.active}</span></div>
            <div>Trial: <span className="font-semibold">{metrics.trial}</span></div>
            <div>Locked: <span className="font-semibold">{metrics.locked}</span></div>
            <div>Grace: <span className="font-semibold">{metrics.grace}</span></div>
          </CardContent>
        </Card>

        <Card className="shadow-card">
          <CardHeader>
            <CardTitle>Estimated MRR</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-extrabold">${fmtMoney(metrics.estimatedMrr)}</div>
            <div className="text-xs text-muted-foreground mt-1">
              Based on active/grace businesses and current plan monthly fees.
            </div>
          </CardContent>
        </Card>

        <Card className="shadow-card">
          <CardHeader>
            <CardTitle>New (30 Days)</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-extrabold">{metrics.newBusinesses30d}</div>
            <div className="text-xs text-muted-foreground mt-1">
              Businesses created in the last 30 days.
            </div>
          </CardContent>
        </Card>

        <Card className="shadow-card">
          <CardHeader>
            <CardTitle>Devices</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            <div>Active: <span className="font-semibold">{metrics.activeDevices}</span></div>
            <div>PC: <span className="font-semibold">{metrics.deviceDistribution.pc}</span></div>
            <div>Phone: <span className="font-semibold">{metrics.deviceDistribution.phone}</span></div>
            <div>Unknown: <span className="font-semibold">{metrics.deviceDistribution.unknown}</span></div>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <Card className="shadow-card">
          <CardHeader>
            <CardTitle>Plan Distribution</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="rounded-xl border border-border overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Plan</TableHead>
                    <TableHead>Businesses</TableHead>
                    <TableHead className="text-right">Monthly</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {!metrics.planBreakdown.length ? (
                    <TableRow>
                      <TableCell colSpan={3} className="text-sm text-muted-foreground">
                        No plan usage yet
                      </TableCell>
                    </TableRow>
                  ) : (
                    metrics.planBreakdown.map((p) => (
                      <TableRow key={p.plan_type}>
                        <TableCell className="text-sm font-medium">{p.name}</TableCell>
                        <TableCell className="text-sm">{p.count}</TableCell>
                        <TableCell className="text-right text-sm">
                          ${fmtMoney(p.monthly_fee)}
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>

        <Card className="shadow-card">
          <CardHeader>
            <CardTitle>Recent Businesses</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {!recentBusinesses.length ? (
                <div className="text-sm text-muted-foreground">No businesses found.</div>
              ) : (
                recentBusinesses.map((b) => (
                  <div
                    key={b.id}
                    className="rounded-xl border border-border px-3 py-2 flex items-center justify-between gap-2"
                  >
                    <div className="min-w-0">
                      <div className="text-sm font-semibold truncate">{b.name}</div>
                      <div className="text-xs text-muted-foreground truncate">
                        {b.plan_type} • {new Date(b.created_at).toLocaleDateString()}
                      </div>
                    </div>
                    <Badge
                      variant={
                        b.access_state === "locked"
                          ? "destructive"
                          : b.access_state === "trial" || b.access_state === "grace"
                            ? "outline"
                            : "secondary"
                      }
                    >
                      {b.access_state}
                    </Badge>
                  </div>
                ))
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

export default PlatformOverviewPage;
