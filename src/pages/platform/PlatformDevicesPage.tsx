import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { supabase } from "@/lib/supabase";
import { friendlyAdminError, requirePlatformCloudSession } from "@/lib/platformAdminUtils";

import { PlatformPageHeader } from "@/components/platform/PlatformPageHeader";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

type DeviceRow = {
  id: string;
  business_id: string;
  device_id: string;
  platform: string | null;
  device_type: string | null;
  device_label: string | null;
  active: boolean;
  registered_at: string;
  last_seen_at: string;
  businesses?: { name?: string | null } | null;
};

export function PlatformDevicesPage() {
  const qc = useQueryClient();
  const [search, setSearch] = useState("");

  const { data: devices = [], isFetching } = useQuery({
    queryKey: ["platform", "devices"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("business_devices")
        .select(
          "id, business_id, device_id, platform, device_type, device_label, active, registered_at, last_seen_at, businesses(name)"
        )
        .order("active", { ascending: false })
        .order("last_seen_at", { ascending: false })
        .limit(500);
      if (error) throw error;
      return (data || []) as unknown as DeviceRow[];
    },
    staleTime: 10_000,
    refetchOnWindowFocus: false,
  });

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return devices;
    return devices.filter((d) => {
      return (
        String(d.businesses?.name || "").toLowerCase().includes(q) ||
        String(d.business_id || "").toLowerCase().includes(q) ||
        String(d.device_id || "").toLowerCase().includes(q) ||
        String(d.platform || "").toLowerCase().includes(q) ||
        String(d.device_type || "").toLowerCase().includes(q)
      );
    });
  }, [devices, search]);

  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: ["platform", "devices"] });
    await qc.invalidateQueries({ queryKey: ["platform", "businessDevices"] });
    await qc.invalidateQueries({ queryKey: ["platform", "tenantHealth"] });
  };

  const setDeviceActive = async (row: DeviceRow, nextActive: boolean) => {
    try {
      if (!(await requirePlatformCloudSession())) return;
      const { error } = await supabase
        .from("business_devices")
        .update({ active: nextActive } as any)
        .eq("id", row.id);
      if (error) throw error;
      toast.success(nextActive ? "Device activated" : "Device deactivated");
      await refresh();
    } catch (e: any) {
      toast.error(friendlyAdminError(e) || "Failed to update device");
    }
  };

  return (
    <div className="p-4 md:p-6 space-y-4">
      <PlatformPageHeader
        title="Devices"
        subtitle="View device registrations by business and activate/deactivate slots."
      />

      <Card className="shadow-card">
        <CardHeader>
          <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-3">
            <CardTitle>Business Devices</CardTitle>
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search device / business / platform"
              className="w-[320px] max-w-full"
            />
          </div>
        </CardHeader>
        <CardContent>
          <div className="rounded-xl border border-border overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Business</TableHead>
                  <TableHead>Device</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Last Seen</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {!filtered.length ? (
                  <TableRow>
                    <TableCell colSpan={6} className="text-sm text-muted-foreground">
                      {isFetching ? "Loading..." : "No devices found"}
                    </TableCell>
                  </TableRow>
                ) : (
                  filtered.map((d) => (
                    <TableRow key={d.id}>
                      <TableCell className="text-sm">
                        <div className="font-semibold">{d.businesses?.name || "—"}</div>
                        <div className="text-xs text-muted-foreground">{d.business_id}</div>
                      </TableCell>
                      <TableCell className="text-sm">
                        <div>{d.device_label || d.platform || "device"}</div>
                        <div className="text-xs text-muted-foreground truncate max-w-[280px]">
                          {d.device_id}
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline">{d.device_type || "unknown"}</Badge>
                      </TableCell>
                      <TableCell className="text-sm">
                        {d.last_seen_at ? new Date(d.last_seen_at).toLocaleString() : "—"}
                      </TableCell>
                      <TableCell>
                        <Badge variant={d.active ? "secondary" : "destructive"}>
                          {d.active ? "active" : "inactive"}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          size="sm"
                          variant={d.active ? "outline" : "default"}
                          onClick={() => void setDeviceActive(d, !d.active)}
                        >
                          {d.active ? "Deactivate" : "Activate"}
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export default PlatformDevicesPage;
