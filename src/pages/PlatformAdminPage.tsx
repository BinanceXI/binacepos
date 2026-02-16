import { useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { BRAND } from "@/lib/brand";
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

type BusinessRow = {
  id: string;
  name: string;
  status: "active" | "suspended" | string;
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

function daysFromNow(d: Date) {
  return Math.ceil((d.getTime() - Date.now()) / (24 * 60 * 60 * 1000));
}

function computeAccessState(b: BusinessRow) {
  const paid = b.business_billing?.paid_through ? new Date(b.business_billing.paid_through) : null;
  const graceDays = b.business_billing?.grace_days ?? 7;
  const overrideLocked = b.business_billing?.locked_override === true;

  if (b.status === "suspended" || overrideLocked) return "locked";
  if (!paid || Number.isNaN(paid.getTime())) return "locked";

  const graceEnd = new Date(paid.getTime() + graceDays * 24 * 60 * 60 * 1000);
  if (Date.now() <= paid.getTime()) return "active";
  if (Date.now() <= graceEnd.getTime()) return "grace";
  return "locked";
}

function sanitizeUsername(raw: string) {
  return String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "");
}

export function PlatformAdminPage() {
  const qc = useQueryClient();

  const [newBusinessName, setNewBusinessName] = useState("");
  const [selectedBusinessId, setSelectedBusinessId] = useState<string | null>(null);

  const [paymentAmount, setPaymentAmount] = useState("15");
  const [paymentKind, setPaymentKind] = useState<"setup" | "subscription" | "reactivation" | "manual">("subscription");
  const [extendMonths, setExtendMonths] = useState("1");

  const [newAdminFullName, setNewAdminFullName] = useState("");
  const [newAdminUsername, setNewAdminUsername] = useState("");
  const [newAdminPassword, setNewAdminPassword] = useState("");

  const { data: businesses = [], isFetching } = useQuery({
    queryKey: ["platform", "businesses"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("businesses")
        .select("id, name, status, created_at, business_billing(paid_through, grace_days, locked_override, currency, max_devices)")
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

  const createBusiness = async () => {
    const name = String(newBusinessName || "").trim();
    if (!name) return toast.error("Business name required");

    try {
      const { data, error } = await supabase.from("businesses").insert({ name, status: "active" }).select("*").single();
      if (error) throw error;
      toast.success(`Created ${data?.name || "business"}`);
      setNewBusinessName("");
      await qc.invalidateQueries({ queryKey: ["platform", "businesses"] });
      if (data?.id) setSelectedBusinessId(String(data.id));
    } catch (e: any) {
      toast.error(e?.message || "Failed to create business");
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
      toast.error(e?.message || "Failed to create business admin");
    }
  };

  const toggleDeviceActive = async (device: DeviceRow, nextActive: boolean) => {
    if (!selected) return toast.error("Select a business");
    try {
      const { error } = await supabase.from("business_devices").update({ active: nextActive }).eq("id", device.id);
      if (error) throw error;
      toast.success(nextActive ? "Device reactivated" : "Device deactivated");
      await qc.invalidateQueries({ queryKey: ["platform", "businessDevices", selected.id] });
    } catch (e: any) {
      toast.error(e?.message || "Failed to update device");
    }
  };

  const recordPaymentAndActivate = async () => {
    if (!selected) return toast.error("Select a business");

    const amount = Number(paymentAmount);
    const months = Math.max(0, Math.min(24, Number(extendMonths) || 0));
    if (!Number.isFinite(amount) || amount <= 0) return toast.error("Enter a valid amount");

    try {
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
      toast.error(e?.message || "Failed to activate");
    }
  };

  const generateReactivationCode = async () => {
    if (!selected) return toast.error("Select a business");
    const months = Math.max(1, Math.min(24, Number(extendMonths) || 1));

    try {
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
      toast.error(e?.message || "Failed to generate code");
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
        <CardContent className="flex flex-col md:flex-row gap-3 md:items-end">
          <div className="flex-1 space-y-2">
            <Label>Business name</Label>
            <Input value={newBusinessName} onChange={(e) => setNewBusinessName(e.target.value)} placeholder="Tengelele Store" />
          </div>
          <Button onClick={createBusiness}>Create</Button>
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
                    <TableHead>Status</TableHead>
                    <TableHead>Paid Through</TableHead>
                    <TableHead>State</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {!businesses.length && (
                    <TableRow>
                      <TableCell colSpan={4} className="text-sm text-muted-foreground">
                        {isFetching ? "Loading..." : "No businesses yet"}
                      </TableCell>
                    </TableRow>
                  )}
                  {businesses.map((b) => {
                    const state = computeAccessState(b);
                    const paid = b.business_billing?.paid_through ? new Date(b.business_billing.paid_through) : null;
                    const paidText = paid && !Number.isNaN(paid.getTime()) ? paid.toLocaleDateString() : "—";
                    const isSelected = selectedBusinessId === b.id;

                    return (
                      <TableRow
                        key={b.id}
                        className={isSelected ? "bg-primary/6" : ""}
                        onClick={() => setSelectedBusinessId(b.id)}
                        style={{ cursor: "pointer" }}
                      >
                        <TableCell className="font-medium">{b.name}</TableCell>
                        <TableCell>
                          <Badge variant={b.status === "active" ? "secondary" : "destructive"}>{b.status}</Badge>
                        </TableCell>
                        <TableCell className="text-sm">
                          {paidText}
                          {paid && state !== "active" ? (
                            <span className="ml-2 text-xs text-muted-foreground">
                              ({daysFromNow(paid)}d)
                            </span>
                          ) : null}
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

                <div className="grid grid-cols-1 gap-3">
                  <div className="space-y-2">
                    <Label>Kind</Label>
                    <Select
                      value={paymentKind}
                      onValueChange={(v) => {
                        const k = v as any;
                        setPaymentKind(k);
                        if (k === "setup") {
                          setPaymentAmount("40");
                          setExtendMonths("0");
                        }
                        if (k === "subscription") {
                          setPaymentAmount("15");
                          setExtendMonths((m) => (String(m || "").trim() === "0" ? "1" : m));
                        }
                      }}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="subscription" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="setup">Setup ($40)</SelectItem>
                        <SelectItem value="subscription">Subscription ($15)</SelectItem>
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
                    {selected.business_billing?.max_devices ?? 2})
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
                    Default license is 2 active devices (1 computer + 1 mobile). Deactivate old devices to free a slot.
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
