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

export function PlatformAnalyticsPage() {
  const { metrics, isFetching, refetchAll } = usePlatformCommercialMetrics();

  const topLocked = useMemo(
    () =>
      metrics.businesses
        .filter((b) => b.access_state === "locked")
        .sort((a, b) => Date.parse(b.created_at || "") - Date.parse(a.created_at || ""))
        .slice(0, 20),
    [metrics.businesses]
  );

  return (
    <div className="p-4 md:p-6 space-y-4">
      <PlatformPageHeader
        title="Analytics"
        subtitle="Simple operational analytics for commercialization decisions."
        right={
          <Button variant="outline" onClick={() => void refetchAll()}>
            Refresh
          </Button>
        }
      />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card className="shadow-card">
          <CardHeader>
            <CardTitle>Business Funnel</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div className="flex items-center justify-between">
              <span>Trial</span>
              <Badge variant="outline">{metrics.trial}</Badge>
            </div>
            <div className="flex items-center justify-between">
              <span>Active</span>
              <Badge variant="secondary">{metrics.active}</Badge>
            </div>
            <div className="flex items-center justify-between">
              <span>Grace</span>
              <Badge variant="outline">{metrics.grace}</Badge>
            </div>
            <div className="flex items-center justify-between">
              <span>Locked</span>
              <Badge variant="destructive">{metrics.locked}</Badge>
            </div>
            <div className="pt-2 text-xs text-muted-foreground">
              Total businesses: {metrics.total}
            </div>
          </CardContent>
        </Card>

        <Card className="shadow-card">
          <CardHeader>
            <CardTitle>Revenue Estimate</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <div className="text-3xl font-extrabold">
              ${fmtMoney(metrics.estimatedMrr)}
            </div>
            <div className="text-sm text-muted-foreground">
              Estimated monthly recurring revenue from active/grace businesses.
            </div>
            <div className="text-sm">
              Avg active devices per business:{" "}
              <span className="font-semibold">{metrics.avgDevicesPerBusiness}</span>
            </div>
          </CardContent>
        </Card>

        <Card className="shadow-card">
          <CardHeader>
            <CardTitle>Device Distribution</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div className="flex items-center justify-between">
              <span>PC</span>
              <span className="font-semibold">{metrics.deviceDistribution.pc}</span>
            </div>
            <div className="flex items-center justify-between">
              <span>Phone</span>
              <span className="font-semibold">{metrics.deviceDistribution.phone}</span>
            </div>
            <div className="flex items-center justify-between">
              <span>Unknown</span>
              <span className="font-semibold">{metrics.deviceDistribution.unknown}</span>
            </div>
            <div className="text-xs text-muted-foreground pt-1">
              Based on active registered devices.
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <Card className="shadow-card">
          <CardHeader>
            <CardTitle>Plan Breakdown</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="rounded-xl border border-border overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Plan</TableHead>
                    <TableHead>Businesses</TableHead>
                    <TableHead className="text-right">Monthly Fee</TableHead>
                    <TableHead className="text-right">Est. MRR</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {!metrics.planBreakdown.length ? (
                    <TableRow>
                      <TableCell colSpan={4} className="text-sm text-muted-foreground">
                        {isFetching ? "Loading..." : "No plan data"}
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
                        <TableCell className="text-right text-sm font-semibold">
                          ${fmtMoney(p.monthly_fee * p.count)}
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
            <CardTitle>Locked Businesses (Recent)</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2 max-h-[460px] overflow-auto pos-scrollbar pr-1">
              {!topLocked.length ? (
                <div className="text-sm text-muted-foreground">
                  No locked businesses found.
                </div>
              ) : (
                topLocked.map((b) => (
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
                    <Badge variant="destructive">locked</Badge>
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

export default PlatformAnalyticsPage;
