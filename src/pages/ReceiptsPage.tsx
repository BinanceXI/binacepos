// File: src/pages/ReceiptsPage.tsx
import { useEffect, useMemo, useState, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Printer,
  Save,
  RefreshCw,
  FileImage,
  Settings2,
  ShieldCheck,
  Receipt,
  Copy,
  WifiOff,
  Cloud,
  Search,
  X,
  Ban,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { usePOS } from "@/contexts/POSContext";
import { toast } from "sonner";
import { supabase } from "@/lib/supabase";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { PrintableReceipt } from "@/components/pos/PrintableReceipt";
import type { CartItem, Product, Discount } from "@/types/pos";
import { Capacitor } from "@capacitor/core";
// 🔥 THERMAL PRINTER
import {
  PRINTER_MODE_KEY,
  PRINTER_IP_KEY,
  PRINTER_PORT_KEY,
  printReceiptSmart,
} from "@/lib/thermalPrint";

import { tryPrintThermalQueue } from "@/lib/thermalPrint";

// --------------------
// Offline queue helpers
// --------------------
const OFFLINE_QUEUE_KEY = "binancexi_offline_queue";

function safeJSONParse<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeOfflineQueue(queue: any[]) {
  localStorage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(queue || []));
  try {
    window.dispatchEvent(new Event("binancexi:queue_changed"));
  } catch {
    // ignore
  }
}

// --------------------
// URL helper (HashRouter safe)
// --------------------
function buildVerifyUrl(baseUrl: string, receiptId: string) {
  let b = (baseUrl || "").trim();
  if (!b) b = window.location.origin;

  b = b.replace(/\/+$/, "");

  if (b.includes("#")) {
    if (!b.endsWith("#")) {
      b = b.split("#")[0].replace(/\/+$/, "") + "/#";
    }
  } else {
    b = b + "/#";
  }

  return `${b}/verify/${receiptId}`;
}

type StoreSettings = {
  id?: string;
  business_name?: string;
  address?: string;
  phone?: string;
  tax_id?: string;
  footer_message?: string;
  show_qr_code?: boolean;
  qr_code_data?: string;
};

type OnlineReceiptRow = {
  id: string;
  receipt_id: string;
  receipt_number: string;
  customer_name: string | null;
  total_amount: number | string;
  payment_method: string | null;
  status: string | null;
  created_at: string;
  profiles?: { full_name?: string | null } | null;

  // optional if you later add them
  subtotal_amount?: number | string | null;
  discount_amount?: number | string | null;
  tax_amount?: number | string | null;

  voided_at?: string | null;
  void_reason?: string | null;
};

type PrintData = {
  cart: CartItem[];
  subtotal: number;
  discount: number;
  tax: number;
  total: number;
  timestamp?: string;
  cashierName: string;
  customerName: string;
  receiptId: string;
  receiptNumber: string;
  paymentMethod: string;
  activeDiscount?: Discount | null;
  taxRatePct?: number;
};

function num(x: any) {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}
function round2(n: number) {
  return Math.round(n * 100) / 100;
}

function toThermalPayload(data: PrintData) {
  return {
    receiptNumber: data.receiptNumber,
    timestamp: data.timestamp || new Date().toISOString(),
    cashierName: data.cashierName || "Staff",
    customerName: data.customerName || "",
    paymentMethod: data.paymentMethod || "cash",
    cart: (data.cart || []).map((it: any) => ({
      product: {
        name: String(it?.product?.name || "Item"),
        price: num(it?.customPrice ?? it?.product?.price ?? 0),
      },
      quantity: Math.max(1, num(it?.quantity) || 1),
      customPrice: it?.customPrice != null ? num(it.customPrice) : undefined,
    })),
    subtotal: num(data.subtotal),
    discount: num(data.discount),
    tax: num(data.tax),
    total: num(data.total),
  };
}

export const ReceiptsPage = () => {
  const { currentUser, can } = usePOS();
  const isAdmin = currentUser?.role === "admin";
  const canVoid = isAdmin || !!currentUser?.permissions?.allowVoid;
  const queryClient = useQueryClient();
  const platform = Capacitor.getPlatform();
  const isAndroid = platform === "android";
  // 🔥 AUTO-RUN THERMAL QUEUE
useEffect(() => {
  tryPrintThermalQueue();
}, []);

useEffect(() => {
  const onOnline = () => tryPrintThermalQueue();
  window.addEventListener("online", onOnline);
  return () => window.removeEventListener("online", onOnline);
}, []);

  const [activeTab, setActiveTab] = useState<"settings" | "receipts">("settings");
  // 🔥 PRINTER SETTINGS
const normalizePrinterMode = (raw: string | null) => {
  const mode = String(raw || "").trim();
  if (mode === "browser" || mode === "tcp") return mode;
  if (isAndroid && mode === "bt") return "bt";
  return isAndroid ? "bt" : "browser";
};
const [printerMode, setPrinterMode] = useState(
  normalizePrinterMode(localStorage.getItem(PRINTER_MODE_KEY))
);
const [printerIp, setPrinterIp] = useState(
  localStorage.getItem(PRINTER_IP_KEY) || ""
);
const [printerPort, setPrinterPort] = useState(
  localStorage.getItem(PRINTER_PORT_KEY) || "9100"
);

  // Preview uses stable fake receipt id + number
  const [previewReceiptId] = useState(
    // @ts-ignore
    globalThis.crypto?.randomUUID?.() ?? `rcpt-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
  const [previewReceiptNumber] = useState(`TM-${Date.now().toString().slice(-6)}`);

  // printing
  const [printData, setPrintData] = useState<PrintData | null>(null);
  const [isPrinting, setIsPrinting] = useState(false);

  const runReprint = useCallback(async (data: PrintData) => {
    setPrintData(data);
    setIsPrinting(true);
    try {
      // Let React commit #receipt-print-area before printer pipeline reads it.
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      await printReceiptSmart(toThermalPayload(data));
      toast.success("Print sent");
    } catch (e: any) {
      toast.error(e?.message || "Print failed");
    } finally {
      setTimeout(() => setIsPrinting(false), 700);
    }
  }, []);
  useEffect(() => {
  if (activeTab !== "receipts") return;

  const ch = supabase
    .channel("orders-live")
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "orders" },
      () => queryClient.invalidateQueries({ queryKey: ["receipts"] })
    )
    .subscribe();

  return () => {
    supabase.removeChannel(ch);
  };
}, [activeTab, queryClient]);

  // --------------------
  // 1) Store settings
  // --------------------
  const { data: settings } = useQuery({
    queryKey: ["storeSettings"],
    queryFn: async () => {
      const { data, error } = await supabase.from("store_settings").select("*").single();

      // No row yet => defaults (PGRST116)
      if (error && (error as any).code !== "PGRST116") throw error;

      const defaults: StoreSettings = {
        business_name: "Your Business",
        address: "",
        phone: "",
        tax_id: "",
        footer_message: "Thank you for your business!",
        show_qr_code: true,
        qr_code_data: window.location.origin,
      };

      return (data as StoreSettings) || defaults;
    },
    staleTime: 1000 * 60 * 60,
    refetchOnWindowFocus: false,
    refetchOnReconnect: true,
  });

  const [formData, setFormData] = useState<StoreSettings>({});
  useEffect(() => {
    if (settings) setFormData(settings);
  }, [settings]);

  // 2) Save settings
  const updateSettingsMutation = useMutation({
    mutationFn: async (newSettings: StoreSettings) => {
      if (!navigator.onLine) throw new Error("You are offline. Connect to save settings.");

      const payload = {
        id: settings?.id,
        ...newSettings,
        updated_at: new Date().toISOString(),
      };

      const { error } = await supabase.from("store_settings").upsert(payload);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["storeSettings"] });
      toast.success("Receipt settings saved");
    },
    onError: (err: any) => toast.error(err?.message || "Save failed"),
  });

  const handleSave = () => {
    if (!isAdmin) return toast.error("Admins only");
    updateSettingsMutation.mutate(formData);
  };

  // 🔥 SAVE PRINTER SETTINGS
const savePrinterSettings = () => {
  const nextMode = normalizePrinterMode(printerMode);
  if (nextMode !== printerMode) setPrinterMode(nextMode);
  localStorage.setItem(PRINTER_MODE_KEY, nextMode);
  localStorage.setItem(PRINTER_IP_KEY, printerIp);
  localStorage.setItem(PRINTER_PORT_KEY, printerPort);

  toast.success("Printer settings saved");
  tryPrintThermalQueue(); // 🔥 PRINT ANY QUEUED RECEIPTS
};

// 🔥 TEST THERMAL PRINT
const testThermalPrint = async () => {
  await runReprint({
    cart: [
      {
        lineId: `test-${Date.now()}`,
        product: { id: "test", name: "TEST ITEM", price: 1, category: "General", type: "good" },
        quantity: 1,
        discount: 0,
        discountType: "percentage",
        customPrice: 1,
      } as any,
    ],
    subtotal: 1,
    discount: 0,
    tax: 0,
    total: 1,
    timestamp: new Date().toISOString(),
    cashierName: "SYSTEM",
    customerName: "",
    receiptId: "test-receipt-id",
    receiptNumber: "TEST-0001",
    paymentMethod: "cash",
  });
};

  // preview verify link (HashRouter safe)
  const previewVerifyUrl = useMemo(() => {
    const base = formData.qr_code_data || window.location.origin;
    return buildVerifyUrl(base, previewReceiptId);
  }, [formData.qr_code_data, previewReceiptId]);

  // --------------------
  // 3) Receipts list (online)
  // --------------------
  const [q, setQ] = useState("");
  const isOnline = typeof navigator !== "undefined" ? navigator.onLine : true;

  const { data: onlineReceipts = [], isLoading: receiptsLoading, refetch } = useQuery({
    queryKey: ["receipts", q],
    queryFn: async () => {
  if (!navigator.onLine) return [];

  const base = supabase
    .from("orders")
    .select("id,receipt_id,receipt_number,customer_name,total_amount,payment_method,status,created_at,cashier_id")
    .order("created_at", { ascending: false })
    .limit(200);

  if (q.trim()) {
    const s = q.trim();
    base.or(`receipt_number.ilike.%${s}%,customer_name.ilike.%${s}%`);
  }

  const { data: orders, error } = await base;
  if (error) throw error;

  const cashierIds = Array.from(new Set((orders || []).map((o: any) => o.cashier_id).filter(Boolean)));

  const cashierMap = new Map<string, string>();
  if (cashierIds.length) {
    const { data: profs } = await supabase
      .from("profiles")
      .select("id,full_name")
      .in("id", cashierIds);

    (profs || []).forEach((p: any) => cashierMap.set(p.id, p.full_name || "Staff"));
  }

  return (orders || []).map((o: any) => ({
    ...o,
    profiles: { full_name: cashierMap.get(o.cashier_id) || "Staff" },
  })) as any[];
},
    enabled: activeTab === "receipts",
    staleTime: 1000 * 20,
    refetchOnWindowFocus: false,
    refetchOnReconnect: true,
  });

  // --------------------
  // 4) Offline pending receipts
  // --------------------
  const readOfflineQueue = useCallback(() => {
    const queue = safeJSONParse<any[]>(localStorage.getItem(OFFLINE_QUEUE_KEY), []);
    return (queue || []).slice().reverse();
  }, []);

  const [offlineQueue, setOfflineQueue] = useState<any[]>(() => readOfflineQueue());

  useEffect(() => {
    if (activeTab !== "receipts") return;
    const refresh = () => setOfflineQueue(readOfflineQueue());
    refresh();

    window.addEventListener("binancexi:queue_changed", refresh as any);
    window.addEventListener("storage", refresh as any);
    return () => {
      window.removeEventListener("binancexi:queue_changed", refresh as any);
      window.removeEventListener("storage", refresh as any);
    };
  }, [activeTab, isOnline, readOfflineQueue]);

  const pendingCount = offlineQueue.length;

  // --------------------
  // actions
  // --------------------
  const copyText = useCallback(async (txt: string) => {
    try {
      await navigator.clipboard.writeText(txt);
      toast.success("Copied");
    } catch {
      toast.error("Copy failed");
    }
  }, []);

  const printOnlineReceipt = useCallback(
    async (row: OnlineReceiptRow) => {
      try {
        const { data, error } = await supabase
          .from("order_items")
          .select("product_name, quantity, price_at_sale")
          .eq("order_id", row.id);

        if (error) throw error;

        const cart: CartItem[] = (data || []).map((it: any, idx: number) => {
          const product: Product = {
            id: `p-${idx}`,
            name: it.product_name,
            price: Number(it.price_at_sale) || 0,
            category: "General",
            type: "good",
          };

          return {
            lineId: `p-${idx}-${Date.now()}`,
            product,
            quantity: Number(it.quantity) || 1,
            discount: 0,
            discountType: "percentage",
            customPrice: Number(it.price_at_sale) || 0,
          } as any;
        });

        const computedSubtotal = round2(
          cart.reduce((s, it: any) => s + num(it.customPrice ?? it.product?.price) * num(it.quantity), 0)
        );

        // If you later store these columns, they’ll be used; otherwise compute clean zeros.
        const subtotal = row.subtotal_amount != null ? num(row.subtotal_amount) : computedSubtotal;
        const discount = row.discount_amount != null ? num(row.discount_amount) : 0;
        const tax = row.tax_amount != null ? num(row.tax_amount) : 0;
        const total = num(row.total_amount) || round2(subtotal - discount + tax);

        const prepared: PrintData = {
          cart,
          subtotal,
          discount,
          tax,
          total,
          timestamp: row.created_at,
          cashierName: row.profiles?.full_name || "Staff",
          customerName: row.customer_name || "",
          receiptId: row.receipt_id || `online-${row.id}`,
          receiptNumber: row.receipt_number || `TM-${String(row.id).slice(0, 6).toUpperCase()}`,
          paymentMethod: row.payment_method || "cash",
        };
        await runReprint(prepared);
      } catch (e: any) {
        toast.error(e?.message || "Failed to load items to print");
      }
    },
    [runReprint]
  );

  const printOfflineReceipt = useCallback(
    async (sale: any) => {
      const cart: CartItem[] = (sale.items || []).map((it: any) => ({
        ...it,
        lineId: it.lineId || `off-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      }));

      const subtotal = round2(
        cart.reduce((s, it: any) => {
          const price = num(it.customPrice ?? it.product?.price);
          return s + price * num(it.quantity);
        }, 0)
      );

      // offline queue currently doesn’t store discount/tax breakdown, so print as 0 unless you add later
      const prepared: PrintData = {
        cart,
        subtotal,
        discount: 0,
        tax: 0,
        total: num(sale.total) || subtotal,
        timestamp: sale?.meta?.timestamp || new Date().toISOString(),
        cashierName: currentUser?.name || currentUser?.full_name || "Staff",
        customerName: sale.customerName || "",
        receiptId: String(sale?.meta?.receiptId || `offline-${Date.now()}`),
        receiptNumber: String(sale?.meta?.receiptNumber || `TM-OFF-${Date.now().toString().slice(-6)}`),
        paymentMethod: sale.payments?.[0]?.method || "cash",
      };
      await runReprint(prepared);
    },
    [currentUser?.name, currentUser?.full_name, runReprint]
  );

  // ✅ VOID (recommended instead of delete)
  const voidReceiptMutation = useMutation({
    mutationFn: async (args: { orderId: string; reason?: string }) => {
      if (!navigator.onLine) throw new Error("You are offline.");
      if (!canVoid) throw new Error("Not allowed to void receipts.");

      const payload: any = {
        status: "voided",
        voided_at: new Date().toISOString(),
        void_reason: args.reason || null,
        voided_by: currentUser?.id || null,
      };

      const { error } = await supabase.from("orders").update(payload).eq("id", args.orderId);
      if (error) throw error;

      // optional: if you have an RPC to restore stock, call it here (best-effort)
      // (kept safe: ignore if function doesn’t exist)
      try {
        const { data: items } = await supabase
          .from("order_items")
          .select("product_id, quantity")
          .eq("order_id", args.orderId);

        for (const it of items || []) {
          await supabase.rpc("increment_stock", {
            p_product_id: it.product_id,
            p_qty: Number(it.quantity) || 0,
          });
        }
      } catch {
        // ignore: receipt will still be voided
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["receipts"] });
      toast.success("Receipt voided");
    },
    onError: (err: any) => toast.error(err?.message || "Void failed"),
  });

  // ✅ HARD DELETE (admin only) — deletes order_items first then order
  const deleteReceiptMutation = useMutation({
    mutationFn: async (args: { orderId: string }) => {
      if (!navigator.onLine) throw new Error("You are offline.");
      if (!isAdmin) throw new Error("Admins only.");

      // Delete items first (avoids FK errors)
      const { error: itemsErr } = await supabase.from("order_items").delete().eq("order_id", args.orderId);
      if (itemsErr) throw itemsErr;

      const { error: orderErr } = await supabase.from("orders").delete().eq("id", args.orderId);
      if (orderErr) throw orderErr;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["receipts"] });
      toast.success("Receipt deleted");
    },
    onError: (err: any) => toast.error(err?.message || "Delete failed"),
  });

  const removeOfflinePending = useCallback(
    (receiptId: string) => {
      const queue = safeJSONParse<any[]>(localStorage.getItem(OFFLINE_QUEUE_KEY), []);
      const next = (queue || []).filter((s: any) => s?.meta?.receiptId !== receiptId);
      writeOfflineQueue(next);
      toast.success("Removed from offline queue");
    },
    []
  );

  const onVoid = useCallback(
    (row: OnlineReceiptRow) => {
      if (!canVoid) return toast.error("Not allowed");
      if (!navigator.onLine) return toast.error("Offline");

      if ((row.status || "").toLowerCase() === "voided") return;

      const ok = window.confirm(`Void receipt ${row.receipt_number}?\n\nThis is safer than delete.`);
      if (!ok) return;

      const reason = window.prompt("Void reason (optional):") || "";
      voidReceiptMutation.mutate({ orderId: row.id, reason });
    },
    [canVoid, voidReceiptMutation]
  );

  const onDelete = useCallback(
    (row: OnlineReceiptRow) => {
      if (!isAdmin) return toast.error("Admins only");
      if (!navigator.onLine) return toast.error("Offline");

      const ok = window.confirm(
        `DELETE receipt ${row.receipt_number}?\n\nThis will permanently remove the order and its items.`
      );
      if (!ok) return;

      deleteReceiptMutation.mutate({ orderId: row.id });
    },
    [isAdmin, deleteReceiptMutation]
  );

  // --------------------
  // UI
  // --------------------
  return (
    <div className="flex h-full flex-col lg:flex-row gap-6 p-4 md:p-6 bg-slate-950 min-h-screen">
      {/* LEFT */}
      <div className="flex-1 flex flex-col gap-5 max-w-4xl">
        {/* Header */}
        <div className="flex items-start md:items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl md:text-3xl font-bold text-white tracking-tight">Receipts</h1>
            <p className="text-slate-400 text-sm">Settings, verification links, reprint, void/delete, offline pending.</p>
          </div>

          {activeTab === "settings" && (
            <Button
              onClick={handleSave}
              disabled={updateSettingsMutation.isPending || !isAdmin}
              className="bg-blue-600 hover:bg-blue-500 text-white shadow-lg shadow-blue-500/20"
              title={!isAdmin ? "Admins only" : undefined}
            >
              {updateSettingsMutation.isPending ? (
                <RefreshCw className="animate-spin mr-2 h-4 w-4" />
              ) : (
                <Save className="mr-2 h-4 w-4" />
              )}
              Save
            </Button>
          )}
        </div>

        {/* Tabs */}
        <div className="flex p-1 bg-slate-900/50 border border-slate-800 rounded-xl w-fit backdrop-blur-md">
          <TabButton active={activeTab === "settings"} onClick={() => setActiveTab("settings")} icon={FileImage} label="Settings" />
          <TabButton active={activeTab === "receipts"} onClick={() => setActiveTab("receipts")} icon={Receipt} label="Receipts" />
        </div>

        <AnimatePresence mode="wait">
          {/* SETTINGS TAB */}
          {activeTab === "settings" ? (
            <motion.div
              key="settings"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              className="space-y-5"
            >
              <SettingsCard title="Store Identity" icon={Settings2}>
               {/* ✅ THERMAL PRINTER SETTINGS */}
<SettingsCard title="Thermal Printer" icon={Printer}>
  <div className="space-y-4">

    <Field label="Printer Mode">
      <select
        value={printerMode}
        onChange={(e) => setPrinterMode(e.target.value)}
        className="w-full bg-slate-950 border border-slate-800 text-white p-2 rounded"
        disabled={!isAdmin}
      >
        {isAndroid && <option value="bt">Bluetooth (Android)</option>}
        <option value="tcp">Thermal (LAN / Wi-Fi)</option>
        <option value="browser">Browser (Fallback)</option>
      </select>
    </Field>

    <Field label="Printer IP">
      <Input
        value={printerIp}
        onChange={(e) => setPrinterIp(e.target.value)}
        placeholder="192.168.1.100"
        className="bg-slate-950 border-slate-800 text-white"
        disabled={!isAdmin}
      />
    </Field>

    <Field label="Printer Port">
      <Input
        value={printerPort}
        onChange={(e) => setPrinterPort(e.target.value)}
        placeholder="9100"
        className="bg-slate-950 border-slate-800 text-white"
        disabled={!isAdmin}
      />
    </Field>

    <div className="flex gap-2">
      <Button onClick={savePrinterSettings} className="flex-1" disabled={!isAdmin}>
        Save Printer
      </Button>

      <Button onClick={testThermalPrint} variant="outline" className="flex-1">
        Test Print
      </Button>
    </div>

  </div>
</SettingsCard>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <Field label="Business Name">
                    <Input
                      value={formData.business_name || ""}
                      onChange={(e) => setFormData({ ...formData, business_name: e.target.value })}
                      className="bg-slate-950 border-slate-800 text-white focus:ring-blue-500"
                      disabled={!isAdmin}
                    />
                  </Field>

                  <Field label="Tax ID / ZIMRA">
                    <Input
                      value={formData.tax_id || ""}
                      onChange={(e) => setFormData({ ...formData, tax_id: e.target.value })}
                      className="bg-slate-950 border-slate-800 text-white focus:ring-blue-500"
                      disabled={!isAdmin}
                    />
                  </Field>

                  <Field label="Address" full>
                    <Input
                      value={formData.address || ""}
                      onChange={(e) => setFormData({ ...formData, address: e.target.value })}
                      className="bg-slate-950 border-slate-800 text-white focus:ring-blue-500"
                      disabled={!isAdmin}
                    />
                  </Field>

                  <Field label="Phone" full>
                    <Input
                      value={formData.phone || ""}
                      onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
                      className="bg-slate-950 border-slate-800 text-white focus:ring-blue-500"
                      disabled={!isAdmin}
                    />
                  </Field>

                  <Field label="Footer Message" full>
                    <Textarea
                      value={formData.footer_message || ""}
                      onChange={(e) => setFormData({ ...formData, footer_message: e.target.value })}
                      className="bg-slate-950 border-slate-800 text-white focus:ring-blue-500 min-h-[90px]"
                      disabled={!isAdmin}
                    />
                  </Field>
                </div>
              </SettingsCard>

              <SettingsCard title="Security & Verification" icon={ShieldCheck}>
                <div className="flex items-center justify-between p-3 bg-slate-950/50 rounded-lg border border-slate-800">
                  <div className="space-y-1">
                    <Label className="text-white">Show QR Code</Label>
                    <p className="text-xs text-slate-400">
                      QR contains the factual <b>receipt_id</b> and opens verification page.
                    </p>
                  </div>
                  <Switch checked={formData.show_qr_code !== false} onCheckedChange={(c) => setFormData({ ...formData, show_qr_code: c })} disabled={!isAdmin} />
                </div>

                {formData.show_qr_code !== false && (
                  <div className="mt-4 space-y-2">
                    <Label className="text-slate-300">Verification Base URL</Label>
                    <Input
                      value={formData.qr_code_data || ""}
                      onChange={(e) => setFormData({ ...formData, qr_code_data: e.target.value })}
                      className="bg-slate-950 border-slate-800 text-white font-mono text-xs"
                      placeholder={window.location.origin}
                      disabled={!isAdmin}
                    />

                    <div className="mt-3 flex items-center gap-2">
                      <Button type="button" variant="outline" className="border-slate-700 text-slate-300 hover:text-white" onClick={() => copyText(previewVerifyUrl)}>
                        <Copy className="w-4 h-4 mr-2" /> Copy Preview Link
                      </Button>
                      <div className="text-xs text-slate-400 font-mono truncate">{previewVerifyUrl}</div>
                    </div>

                    <div className="mt-4 bg-white rounded-xl p-4 w-fit">
                      <div className="text-center text-xs font-mono mb-2">Preview</div>
                      <div className="text-[10px] text-slate-500 mt-2">
                        receipt_number: <b>{previewReceiptNumber}</b>
                      </div>
                    </div>
                  </div>
                )}
              </SettingsCard>
            </motion.div>
          ) : (
            /* RECEIPTS TAB */
            <motion.div
              key="receipts"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              className="space-y-5"
            >
              {/* top bar */}
              <div className="flex flex-col md:flex-row gap-3 md:items-center md:justify-between">
                <div className="flex items-center gap-2 text-xs font-mono bg-slate-900/60 border border-slate-800 px-3 py-2 rounded-xl w-fit">
                  {isOnline ? (
                    <>
                      <Cloud className="w-4 h-4 text-emerald-400" /> Online
                    </>
                  ) : (
                    <>
                      <WifiOff className="w-4 h-4 text-amber-400" /> Offline
                    </>
                  )}
                  <span className="text-slate-400">•</span>
                  <span className="text-slate-300">
                    Pending Sync: <b className="text-white">{pendingCount}</b>
                  </span>
                </div>

                <div className="flex gap-2">
                  <div className="relative flex-1 min-w-[240px]">
                    <Search className="absolute left-3 top-2.5 w-4 h-4 text-slate-500" />
                    <Input
                      value={q}
                      onChange={(e) => setQ(e.target.value)}
                      placeholder="Search receipt number / customer..."
                      className="pl-9 bg-slate-950 border-slate-800 text-white"
                      disabled={!isOnline}
                      title={!isOnline ? "Search needs internet" : undefined}
                    />
                    {q && (
                      <button className="absolute right-2 top-2.5 text-slate-500 hover:text-white" onClick={() => setQ("")} type="button">
                        <X className="w-4 h-4" />
                      </button>
                    )}
                  </div>

                  <Button
                    variant="outline"
                    className="border-slate-700 text-slate-300 hover:text-white"
                    onClick={() => refetch()}
                    disabled={!isOnline}
                    title={!isOnline ? "Offline" : "Refresh receipts"}
                  >
                    <RefreshCw className="w-4 h-4 mr-2" /> Refresh
                  </Button>
                </div>
              </div>

              {/* OFFLINE PENDING */}
              {pendingCount > 0 && (
                <SettingsCard title="Offline Pending Receipts (Not Yet Synced)" icon={WifiOff}>
                  <div className="space-y-2">
                    {offlineQueue.slice(0, 10).map((sale: any, idx: number) => {
                      const rid = sale?.meta?.receiptId || "unknown";
                      const rnum = sale?.meta?.receiptNumber || "TM-??????";
                      const t = sale?.meta?.timestamp ? new Date(sale.meta.timestamp) : null;
                      const verifyUrl = buildVerifyUrl(formData.qr_code_data || window.location.origin, rid);

                      return (
                        <div
                          key={`${rid}-${idx}`}
                          className="flex flex-col md:flex-row md:items-center justify-between gap-3 p-3 rounded-xl border border-amber-500/20 bg-amber-500/10"
                        >
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="text-white font-mono font-bold">{rnum}</span>
                              <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-200">PENDING SYNC</span>
                            </div>
                            <div className="text-xs text-slate-200/80">
                              {sale.customerName ? `Customer: ${sale.customerName}` : "Walk-in"} • {t ? t.toLocaleString() : "Unknown time"}
                            </div>
                            <div className="text-xs text-slate-200/70 font-mono break-all mt-1">receipt_id: {rid}</div>
                            {sale?.lastError && (
                              <div className="text-[11px] text-amber-200/80 mt-1 break-words">
                                Last error: {String(sale.lastError)}
                              </div>
                            )}
                          </div>

                          <div className="flex gap-2 flex-wrap">
                            <Button size="sm" variant="outline" className="border-slate-700 text-slate-200 hover:text-white" onClick={() => copyText(verifyUrl)}>
                              <Copy className="w-4 h-4 mr-2" /> Copy Verify Link
                            </Button>

                            <Button size="sm" className="bg-white text-slate-900 hover:bg-slate-200" onClick={() => printOfflineReceipt(sale)}>
                              <Printer className="w-4 h-4 mr-2" /> Reprint
                            </Button>

                            {isAdmin && (
                              <Button
                                size="sm"
                                variant="outline"
                                className="border-amber-500/40 text-amber-200 hover:text-white hover:bg-amber-500/10"
                                onClick={() => {
                                  const ok = window.confirm(`Remove ${rnum} from offline queue?`);
                                  if (!ok) return;
                                  removeOfflinePending(rid);
                                }}
                              >
                                <Trash2 className="w-4 h-4 mr-2" /> Remove
                              </Button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                    {pendingCount > 10 && <div className="text-xs text-slate-400 mt-2">Showing 10 of {pendingCount} pending receipts.</div>}
                  </div>
                </SettingsCard>
              )}

              {/* ONLINE RECEIPTS */}
              <SettingsCard title="Receipts History (Online)" icon={Receipt}>
                {!isOnline ? (
                  <div className="text-sm text-slate-400">You are offline. Online receipts history will show when connected.</div>
                ) : receiptsLoading ? (
                  <div className="text-sm text-slate-400">Loading receipts…</div>
                ) : onlineReceipts.length === 0 ? (
                  <div className="text-sm text-slate-400">No receipts found.</div>
                ) : (
                  <div className="space-y-2">
                    {onlineReceipts.map((row) => {
                      const verifyUrl = buildVerifyUrl(formData.qr_code_data || window.location.origin, row.receipt_id);
                      const status = String(row.status || "completed").toLowerCase();
                      const isVoided = status === "voided";

                      return (
                        <div
                          key={row.id}
                          className="flex flex-col md:flex-row md:items-center justify-between gap-3 p-3 rounded-xl border border-slate-800 bg-slate-950/40"
                        >
                          <div className="min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="text-white font-mono font-bold">{row.receipt_number}</span>

                              <span
                                className={cn(
                                  "text-[10px] px-2 py-0.5 rounded-full border",
                                  isVoided
                                    ? "bg-red-500/10 text-red-300 border-red-500/20"
                                    : status === "completed"
                                      ? "bg-emerald-500/10 text-emerald-300 border-emerald-500/20"
                                      : "bg-amber-500/10 text-amber-300 border-amber-500/20"
                                )}
                              >
                                {String(row.status || "").toUpperCase()}
                              </span>

                              <span className="text-slate-500 text-xs">•</span>
                              <span className="text-slate-300 text-xs">{String(row.payment_method || "cash").toUpperCase()}</span>
                            </div>

                            <div className="text-xs text-slate-400">
                              {row.customer_name ? `Customer: ${row.customer_name}` : "Walk-in"} • {new Date(row.created_at).toLocaleString()}
                            </div>

                            <div className="text-xs text-slate-500">
                              Cashier: {row.profiles?.full_name || "Staff"} • Total:{" "}
                              <b className="text-white">${num(row.total_amount).toFixed(2)}</b>
                            </div>

                            <div className="text-[11px] text-slate-500 font-mono break-all mt-1">receipt_id: {row.receipt_id}</div>

                            {isVoided && row.void_reason && (
                              <div className="text-[11px] text-red-200/80 mt-1">
                                Void reason: <span className="text-red-200">{row.void_reason}</span>
                              </div>
                            )}
                          </div>

                          <div className="flex gap-2 flex-wrap">
                            <Button size="sm" variant="outline" className="border-slate-700 text-slate-200 hover:text-white" onClick={() => copyText(verifyUrl)}>
                              <Copy className="w-4 h-4 mr-2" /> Copy Link
                            </Button>

                            <Button size="sm" className="bg-white text-slate-900 hover:bg-slate-200" onClick={() => printOnlineReceipt(row)}>
                              <Printer className="w-4 h-4 mr-2" /> Reprint
                            </Button>

                            <Button
                              size="sm"
                              variant="outline"
                              className={cn(
                                "border-red-500/40 text-red-200 hover:text-white hover:bg-red-500/10",
                                (!canVoid || isVoided) && "opacity-50 pointer-events-none"
                              )}
                              title={!canVoid ? "Not allowed" : isVoided ? "Already voided" : "Void receipt"}
                              onClick={() => onVoid(row)}
                            >
                              <Ban className="w-4 h-4 mr-2" /> Void
                            </Button>

                            {isAdmin && (
                              <Button
                                size="sm"
                                variant="outline"
                                className="border-slate-700 text-slate-200 hover:text-white hover:bg-slate-800/40"
                                onClick={() => onDelete(row)}
                                disabled={deleteReceiptMutation.isPending}
                                title="Hard delete (admin)"
                              >
                                <Trash2 className="w-4 h-4 mr-2" /> Delete
                              </Button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </SettingsCard>

              {(voidReceiptMutation.isPending || deleteReceiptMutation.isPending) && (
                <div className="text-xs text-slate-400">
                  Working… {voidReceiptMutation.isPending ? "Voiding receipt" : "Deleting receipt"}
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* PRINT AREA */}
      <div id="receipt-print-area" className="fixed top-0 left-[-9999px]">
        {printData && (
          <PrintableReceipt
            cart={printData.cart}
            subtotal={printData.subtotal}
            discount={printData.discount}
            tax={printData.tax}
            total={printData.total}
            cashierName={printData.cashierName}
            customerName={printData.customerName}
            receiptId={printData.receiptId}
            receiptNumber={printData.receiptNumber}
            paymentMethod={printData.paymentMethod}
            activeDiscount={printData.activeDiscount ?? null}
            taxRatePct={printData.taxRatePct}
          />
        )}
      </div>

      {isPrinting && (
        <div className="fixed bottom-4 right-4 bg-card border border-border px-3 py-2 rounded-xl shadow-lg text-xs">
          Printing…
        </div>
      )}
    </div>
  );
};

// ---- UI helpers ----

const SettingsCard = ({ title, icon: Icon, children }: any) => (
  <motion.div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden shadow-sm">
    <div className="px-6 py-4 border-b border-slate-800 flex items-center gap-3">
      <div className="p-2 bg-blue-500/10 rounded-lg">
        <Icon className="h-5 w-5 text-blue-400" />
      </div>
      <h3 className="font-semibold text-white">{title}</h3>
    </div>
    <div className="p-6">{children}</div>
  </motion.div>
);

const TabButton = ({ active, onClick, icon: Icon, label }: any) => (
  <button
    onClick={onClick}
    className={cn(
      "flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all",
      active ? "bg-slate-800 text-white shadow-sm" : "text-slate-400 hover:text-white hover:bg-slate-800/50"
    )}
    type="button"
  >
    <Icon className="h-4 w-4" />
    {label}
  </button>
);

const Field = ({ label, children, full }: { label: string; children: any; full?: boolean }) => (
  <div className={cn("space-y-2", full && "md:col-span-2")}>
    <Label className="text-slate-300">{label}</Label>
    {children}
  </div>
);
