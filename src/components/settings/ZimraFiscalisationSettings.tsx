import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Save, ShieldCheck } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  DEFAULT_TENANT_FISCAL_PROFILE,
  checkFdmsHealth,
  getFiscalProfile,
  type TenantFiscalProfile,
  upsertFiscalProfile,
} from "@/lib/fiscalApi";

type Props = {
  canManage: boolean;
};

function safeFormatJson(value: unknown) {
  try {
    return JSON.stringify(value ?? {}, null, 2);
  } catch {
    return "{}";
  }
}

export function ZimraFiscalisationSettings({ canManage }: Props) {
  const qc = useQueryClient();
  const [form, setForm] = useState<TenantFiscalProfile>(DEFAULT_TENANT_FISCAL_PROFILE);
  const [addressJsonText, setAddressJsonText] = useState("{}");
  const [lastHealth, setLastHealth] = useState<{ ok: boolean; error?: string } | null>(null);

  const profileQuery = useQuery({
    queryKey: ["fiscalProfile"],
    queryFn: getFiscalProfile,
    enabled: canManage,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    const next = profileQuery.data || DEFAULT_TENANT_FISCAL_PROFILE;
    setForm({ ...DEFAULT_TENANT_FISCAL_PROFILE, ...next });
    setAddressJsonText(safeFormatJson(next?.address_json ?? {}));
  }, [profileQuery.data]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      let parsedAddress: unknown = {};
      try {
        parsedAddress = JSON.parse(addressJsonText || "{}");
      } catch {
        throw new Error("Address JSON is invalid");
      }

      return upsertFiscalProfile({
        ...form,
        address_json: parsedAddress,
      });
    },
    onSuccess: async (saved) => {
      setForm({ ...DEFAULT_TENANT_FISCAL_PROFILE, ...saved });
      setAddressJsonText(safeFormatJson(saved.address_json ?? {}));
      await qc.invalidateQueries({ queryKey: ["fiscalProfile"] });
      toast.success("Fiscal profile saved");
    },
    onError: (e: any) => toast.error(e?.message || "Failed to save fiscal profile"),
  });

  const healthMutation = useMutation({
    mutationFn: checkFdmsHealth,
    onSuccess: (res) => {
      setLastHealth(res);
      if (res.ok) toast.success("FDMS reachable");
      else toast.error(res.error || "FDMS health check failed");
    },
    onError: (e: any) => {
      const out = { ok: false, error: e?.message || "FDMS health check failed" } as const;
      setLastHealth(out);
      toast.error(out.error);
    },
  });

  if (!canManage) {
    return (
      <Card>
        <CardContent className="p-6 text-sm text-muted-foreground">
          Tenant admins and master admins only.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <ShieldCheck className="w-5 h-5" />
            ZIMRA Fiscalisation
          </CardTitle>
          <div className="flex items-center gap-2">
            <Badge variant={form.enabled ? "default" : "outline"}>
              {form.enabled ? "Enabled" : "Disabled"}
            </Badge>
            <Button
              variant="outline"
              size="sm"
              onClick={() => healthMutation.mutate()}
              disabled={healthMutation.isPending}
              className="gap-2"
            >
              {healthMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
              FDMS Health
            </Button>
          </div>
        </CardHeader>

        <CardContent className="space-y-4">
          <div className="text-sm text-muted-foreground">
            Phase A scaffolding only. FDMS payload schemas and POS receipt flow integration are not enabled yet.
          </div>

          {profileQuery.isFetching && !profileQuery.data ? (
            <div className="text-sm text-muted-foreground flex items-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading fiscal profile…
            </div>
          ) : null}

          {profileQuery.error ? (
            <div className="text-sm text-red-500">
              {(profileQuery.error as any)?.message || "Failed to load fiscal profile"}
            </div>
          ) : null}

          {lastHealth ? (
            <div className="text-xs text-muted-foreground">
              FDMS health: {lastHealth.ok ? "ok" : `failed${lastHealth.error ? ` (${lastHealth.error})` : ""}`}
            </div>
          ) : null}

          <div className="flex items-center justify-between p-4 rounded-lg bg-muted/50 border border-border">
            <div>
              <p className="font-medium">Enable fiscalisation for this tenant</p>
              <p className="text-xs text-muted-foreground">
                Saves tenant profile only in Phase A. POS flows remain unchanged.
              </p>
            </div>
            <Switch
              checked={!!form.enabled}
              onCheckedChange={(enabled) => setForm((prev) => ({ ...prev, enabled }))}
            />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Environment</Label>
              <Select
                value={form.environment || "test"}
                onValueChange={(v) =>
                  setForm((prev) => ({ ...prev, environment: (v === "prod" ? "prod" : "test") as any }))
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="test">test</SelectItem>
                  <SelectItem value="prod">prod</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>Buyer Policy</Label>
              <Select
                value={form.buyerPolicy || "__empty__"}
                onValueChange={(v) =>
                  setForm((prev) => ({
                    ...prev,
                    buyerPolicy: v === "__empty__" ? "" : (v as any),
                  }))
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select…" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__empty__">Not set</SelectItem>
                  <SelectItem value="optional">optional</SelectItem>
                  <SelectItem value="required">required</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>Taxpayer TIN</Label>
              <Input
                value={form.taxpayerTin || ""}
                onChange={(e) => setForm((prev) => ({ ...prev, taxpayerTin: e.target.value }))}
                placeholder="Taxpayer TIN"
              />
            </div>

            <div className="space-y-2">
              <Label>VAT Number</Label>
              <Input
                value={form.vatNumber || ""}
                onChange={(e) => setForm((prev) => ({ ...prev, vatNumber: e.target.value }))}
                placeholder="VAT number"
              />
            </div>

            <div className="space-y-2">
              <Label>Legal Name</Label>
              <Input
                value={form.legalName || ""}
                onChange={(e) => setForm((prev) => ({ ...prev, legalName: e.target.value }))}
                placeholder="Legal name"
              />
            </div>

            <div className="space-y-2">
              <Label>Trade Name</Label>
              <Input
                value={form.tradeName || ""}
                onChange={(e) => setForm((prev) => ({ ...prev, tradeName: e.target.value }))}
                placeholder="Trade name"
              />
            </div>

            <div className="space-y-2 md:col-span-2">
              <Label>Device Operating Mode</Label>
              <Select
                value={form.deviceOperatingMode || "__empty__"}
                onValueChange={(v) =>
                  setForm((prev) => ({
                    ...prev,
                    deviceOperatingMode: v === "__empty__" ? "" : (v as any),
                  }))
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select…" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__empty__">Not set</SelectItem>
                  <SelectItem value="Online">Online</SelectItem>
                  <SelectItem value="Offline">Offline</SelectItem>
                  <SelectItem value="Hybrid">Hybrid</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2 md:col-span-2">
              <Label>Address JSON</Label>
              <Textarea
                value={addressJsonText}
                onChange={(e) => setAddressJsonText(e.target.value)}
                rows={8}
                className="font-mono text-xs"
                placeholder='{"line1":"...", "city":"..."}'
              />
            </div>
          </div>

          <div className="flex justify-end">
            <Button onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending} className="gap-2">
              {saveMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
              Save Fiscal Profile
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
