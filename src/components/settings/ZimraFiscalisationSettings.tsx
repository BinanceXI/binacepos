import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { HardDrive, Loader2, Save, ShieldCheck, UploadCloud } from "lucide-react";
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
  getFiscalSubmissions,
  listFiscalCredentials,
  listFiscalDevices,
  type TenantFiscalProfile,
  upsertFiscalDevice,
  upsertFiscalProfile,
  uploadFiscalCredential,
} from "@/lib/fiscalApi";
import { getOrCreateDeviceId } from "@/lib/deviceLicense";

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
  const [certPem, setCertPem] = useState("");
  const [keyPem, setKeyPem] = useState("");
  const [caPem, setCaPem] = useState("");
  const [credEnvironment, setCredEnvironment] = useState<"test" | "prod">("test");
  const [deviceIdentifier, setDeviceIdentifier] = useState(() => getOrCreateDeviceId());
  const [fdmsDeviceId, setFdmsDeviceId] = useState("");
  const localDeviceIdentifier = useMemo(() => getOrCreateDeviceId(), []);

  const profileQuery = useQuery({
    queryKey: ["fiscalProfile"],
    queryFn: getFiscalProfile,
    enabled: canManage,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });

  const credentialsQuery = useQuery({
    queryKey: ["fiscalCredentials"],
    queryFn: listFiscalCredentials,
    enabled: canManage,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });

  const devicesQuery = useQuery({
    queryKey: ["fiscalDevices"],
    queryFn: listFiscalDevices,
    enabled: canManage,
    staleTime: 15_000,
    refetchOnWindowFocus: false,
  });

  const submissionsQuery = useQuery({
    queryKey: ["fiscalSubmissions"],
    queryFn: () => getFiscalSubmissions(),
    enabled: canManage,
    staleTime: 10_000,
    refetchOnWindowFocus: false,
    refetchInterval: 30_000,
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

  const uploadCredentialMutation = useMutation({
    mutationFn: async () =>
      uploadFiscalCredential({
        environment: credEnvironment,
        clientCertPem: certPem,
        clientKeyPem: keyPem,
        caCertPem: caPem || undefined,
        active: true,
      }),
    onSuccess: async () => {
      setCertPem("");
      setKeyPem("");
      setCaPem("");
      await qc.invalidateQueries({ queryKey: ["fiscalCredentials"] });
      toast.success("FDMS credentials uploaded");
    },
    onError: (e: any) => toast.error(e?.message || "Failed to upload credentials"),
  });

  const saveDeviceMutation = useMutation({
    mutationFn: async () =>
      upsertFiscalDevice({
        deviceIdentifier: deviceIdentifier.trim(),
        fdmsDeviceId: fdmsDeviceId.trim() || undefined,
        registrationStatus: "pending",
        certificateStatus: "pending",
        configSyncStatus: "pending",
        dayState: "closed",
      }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["fiscalDevices"] });
      toast.success("Fiscal device saved");
    },
    onError: (e: any) => toast.error(e?.message || "Failed to save device"),
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
            Configure tenant profile now, then add credentials + devices before onsite install.
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
                Keep disabled until test credentials and one full receipt UAT cycle pass.
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
                rows={6}
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

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <UploadCloud className="w-5 h-5" />
            FDMS Credentials
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label>Credential Environment</Label>
              <Select value={credEnvironment} onValueChange={(v) => setCredEnvironment(v === "prod" ? "prod" : "test")}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="test">test</SelectItem>
                  <SelectItem value="prod">prod</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-2">
            <Label>Client Certificate PEM</Label>
            <Textarea
              value={certPem}
              onChange={(e) => setCertPem(e.target.value)}
              rows={5}
              className="font-mono text-xs"
              placeholder="-----BEGIN CERTIFICATE-----"
            />
          </div>
          <div className="space-y-2">
            <Label>Client Private Key PEM</Label>
            <Textarea
              value={keyPem}
              onChange={(e) => setKeyPem(e.target.value)}
              rows={5}
              className="font-mono text-xs"
              placeholder="-----BEGIN PRIVATE KEY-----"
            />
          </div>
          <div className="space-y-2">
            <Label>CA Certificate PEM (Optional)</Label>
            <Textarea
              value={caPem}
              onChange={(e) => setCaPem(e.target.value)}
              rows={4}
              className="font-mono text-xs"
              placeholder="-----BEGIN CERTIFICATE-----"
            />
          </div>

          <div className="flex justify-end">
            <Button
              onClick={() => uploadCredentialMutation.mutate()}
              disabled={uploadCredentialMutation.isPending || !certPem.trim() || !keyPem.trim()}
              className="gap-2"
            >
              {uploadCredentialMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <UploadCloud className="w-4 h-4" />}
              Upload Credential
            </Button>
          </div>

          <div className="space-y-2">
            <p className="text-sm font-medium">Recent Credential Versions</p>
            <div className="space-y-2">
              {(credentialsQuery.data || []).map((row) => (
                <div key={row.id} className="rounded-lg border border-border p-3 text-xs md:text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <div className="font-medium">
                      {row.environment.toUpperCase()} v{row.key_version}
                    </div>
                    <Badge variant={row.active ? "default" : "outline"}>
                      {row.active ? "active" : "inactive"}
                    </Badge>
                  </div>
                  <div className="text-muted-foreground mt-1">
                    rotated: {row.rotated_at || "—"} • updated: {row.updated_at || "—"}
                  </div>
                </div>
              ))}
              {!credentialsQuery.isLoading && !(credentialsQuery.data || []).length ? (
                <div className="text-sm text-muted-foreground">No credentials uploaded yet.</div>
              ) : null}
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <HardDrive className="w-5 h-5" />
            Fiscal Devices
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="rounded-lg border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
            Local device identifier for this machine: <span className="font-mono text-foreground">{localDeviceIdentifier}</span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label>Device Identifier</Label>
              <Input
                value={deviceIdentifier}
                onChange={(e) => setDeviceIdentifier(e.target.value)}
                placeholder="e.g. verschard-pc-1"
              />
            </div>
            <div className="space-y-2">
              <Label>FDMS Device ID (Optional)</Label>
              <Input
                value={fdmsDeviceId}
                onChange={(e) => setFdmsDeviceId(e.target.value)}
                placeholder="ZIMRA device ID"
              />
            </div>
          </div>

          <div className="flex justify-end">
            <Button
              onClick={() => saveDeviceMutation.mutate()}
              disabled={saveDeviceMutation.isPending || !deviceIdentifier.trim()}
            >
              {saveDeviceMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
              Save Device
            </Button>
          </div>

          <div className="space-y-2">
            {(devicesQuery.data || []).map((row) => (
              <div key={row.id} className="rounded-lg border border-border p-3 text-xs md:text-sm">
                <div className="flex items-center justify-between gap-2">
                  <div className="font-medium">{row.device_identifier}</div>
                  <Badge variant={row.registration_status === "registered" ? "default" : "outline"}>
                    {row.registration_status}
                  </Badge>
                </div>
                <div className="text-muted-foreground mt-1">
                  fdms: {row.fdms_device_id || "—"} • cert: {row.certificate_status} • config: {row.config_sync_status} • day: {row.day_state}
                </div>
                {row.last_error ? (
                  <div className="text-red-500 mt-1 text-xs">{row.last_error}</div>
                ) : null}
              </div>
            ))}
            {!devicesQuery.isLoading && !(devicesQuery.data || []).length ? (
              <div className="text-sm text-muted-foreground">No fiscal devices registered yet.</div>
            ) : null}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Submission Queue Monitor</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="text-xs text-muted-foreground">
            Pending jobs: {(submissionsQuery.data?.jobs || []).filter((j) => j.status === "pending").length} • Dead letters:{" "}
            {(submissionsQuery.data?.jobs || []).filter((j) => j.status === "dead_letter").length}
          </div>
          <div className="space-y-2">
            {(submissionsQuery.data?.logs || []).slice(0, 8).map((row) => (
              <div key={row.id} className="rounded-lg border border-border p-3 text-xs md:text-sm">
                <div className="flex items-center justify-between gap-2">
                  <div className="font-medium">{row.receipt_number || row.id}</div>
                  <Badge variant={row.status === "accepted" ? "default" : "outline"}>
                    {row.status}
                  </Badge>
                </div>
                <div className="text-muted-foreground mt-1">
                  type: {row.submission_type} • device: {row.device_identifier || row.device_id || "—"} • ref: {row.fdms_reference || "—"}
                </div>
                {row.error_message ? <div className="mt-1 text-red-500">{row.error_message}</div> : null}
              </div>
            ))}
            {!submissionsQuery.isLoading && !(submissionsQuery.data?.logs || []).length ? (
              <div className="text-sm text-muted-foreground">No fiscal submissions yet.</div>
            ) : null}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
