// File: src/pages/VerifyReceiptPage.tsx
import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { supabase } from "@/lib/supabase";
import { motion } from "framer-motion";
import {
  XCircle,
  Loader2,
  ShieldCheck,
  WifiOff,
  BadgeCheck,
  AlertTriangle,
  Receipt,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import { BrandMark } from "@/components/brand/BrandLogo";
import { BRAND } from "@/lib/brand";
import { cn } from "@/lib/utils";

type OrderItem = {
  product_name: string;
  quantity: number;
  price_at_sale: number;
  service_note?: string | null;
};

type OrderRow = {
  business_name: string;
  cashier_name: string;
  receipt_id: string;
  receipt_number: string;
  total_amount: number;
  payment_method: string | null;
  status: string | null;
  created_at: string;
  items: OrderItem[];
};

const prettyStatus = (s?: string | null) => String(s || "unknown").toLowerCase();
const money = (n: any) => Number(n || 0).toFixed(2);

export const VerifyReceiptPage = () => {
  const { id } = useParams<{ id: string }>(); // receipt_id
  const [order, setOrder] = useState<OrderRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const isOnline = typeof navigator !== "undefined" ? navigator.onLine : true;

  useEffect(() => {
    const fetchAll = async () => {
      if (!id) return;

      if (!isOnline) {
        setLoading(false);
        setErrorMsg("offline");
        setOrder(null);
        return;
      }

      try {
        setLoading(true);
        setErrorMsg(null);

        const { data, error: rpcErr } = await supabase.rpc("verify_receipt", { p_receipt_id: id });
        if (rpcErr) {
          console.error("[verify receipt] rpc error:", rpcErr);
          setOrder(null);
          setErrorMsg(rpcErr.message || "query_error");
          return;
        }

        const res = data as any;
        if (!res || res.ok !== true) {
          setOrder(null);
          setErrorMsg(String(res?.error || "not_found"));
          return;
        }

        setOrder({
          business_name: String(res.business_name || ""),
          cashier_name: String(res.cashier_name || ""),
          receipt_id: String(res.receipt_id || ""),
          receipt_number: String(res.receipt_number || ""),
          total_amount: Number(res.total_amount || 0),
          payment_method: res.payment_method ? String(res.payment_method) : null,
          status: res.status ? String(res.status) : null,
          created_at: String(res.created_at || new Date().toISOString()),
          items: (Array.isArray(res.items) ? res.items : []) as any,
        });
      } catch (e: any) {
        console.error(e);
        setOrder(null);
        setErrorMsg(e?.message || "unknown");
      } finally {
        setLoading(false);
      }
    };

    fetchAll();
  }, [id, isOnline]);

  const status = useMemo(() => prettyStatus(order?.status), [order?.status]);
  const isCompleted = status === "completed";
  const isVoided = status === "voided" || status === "void";
  const isRefunded = status === "refunded" || status === "refund";

  const headerTone = isCompleted
    ? "from-emerald-600 to-emerald-900"
    : isVoided || isRefunded
      ? "from-amber-600 to-amber-900"
      : "from-slate-700 to-slate-950";

  const StatusIcon = isCompleted ? BadgeCheck : isVoided || isRefunded ? AlertTriangle : Receipt;

  if (loading) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-slate-950 text-white gap-4 px-4">
        <div className="rounded-2xl border border-slate-800 bg-slate-900/60 px-6 py-5 w-full max-w-sm text-center">
          <Loader2 className="animate-spin w-10 h-10 mx-auto text-white" />
          <p className="mt-3 font-semibold">Verifying receipt…</p>
          <p className="text-xs text-slate-300 mt-1">This needs internet.</p>
        </div>
      </div>
    );
  }

  if (!order || errorMsg) {
    const offline = errorMsg === "offline";
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-950 p-4 text-white">
        <motion.div initial={{ scale: 0.96, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} className="w-full max-w-md">
          <Card className="border-slate-800 bg-slate-900/70 shadow-2xl">
            <CardContent className="flex flex-col items-center py-10 text-center">
              <div
                className={cn(
                  "w-20 h-20 rounded-full flex items-center justify-center mb-6 border",
                  offline
                    ? "bg-amber-500/10 border-amber-500/30"
                    : "bg-red-500/10 border-red-500/30"
                )}
              >
                {offline ? (
                  <WifiOff className="w-10 h-10 text-amber-300" />
                ) : (
                  <XCircle className="w-10 h-10 text-red-300" />
                )}
              </div>

              <h2 className="text-2xl font-bold">
                {offline ? "Offline" : "Receipt Not Found"}
              </h2>

              <p className="text-slate-300 mt-2 text-sm">
                {offline
                  ? "Receipt verification needs internet. Connect and try again."
                  : "This receipt ID does not exist in our records."}
              </p>

              <div className="mt-4 w-full text-left">
                <div className="text-[11px] text-slate-400 mb-1">receipt_id</div>
                <div className="text-xs font-mono break-all rounded-xl border border-slate-800 bg-slate-950/50 px-3 py-2">
                  {id}
                </div>
              </div>

              {!offline && (
                <p className="text-[11px] text-slate-400 mt-4">
                  If this is very recent, wait a moment for sync.
                </p>
              )}
            </CardContent>
          </Card>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-950 py-6 px-3 sm:px-4 flex justify-center">
      <motion.div
        initial={{ opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        className="w-full max-w-md"
      >
        {/* TOP STATUS PILL */}
        <div className="flex justify-center mb-3">
          <div
            className={cn(
              "inline-flex items-center gap-2 rounded-full px-4 py-2 text-xs font-bold tracking-wide border shadow-lg",
                        isCompleted
                ? "bg-emerald-500/15 text-emerald-200 border-emerald-500/30"
                : isVoided || isRefunded
                  ? "bg-amber-500/15 text-amber-200 border-amber-500/30"
                  : "bg-slate-500/15 text-slate-200 border-slate-500/30"
            )}
          >
            <ShieldCheck className="w-4 h-4" />
            {isCompleted ? "OFFICIAL RECEIPT" : isVoided ? "VOIDED" : isRefunded ? "REFUNDED" : "PENDING"}
          </div>
        </div>

        <Card className="overflow-hidden border-slate-800 bg-slate-900/70 shadow-2xl">
          {/* HEADER */}
          <div className={cn("p-6 sm:p-7 text-center bg-gradient-to-b", headerTone)}>
            <div className="flex items-center justify-center gap-3">
              <div className="h-12 w-12 rounded-2xl bg-white/10 border border-white/15 flex items-center justify-center">
                <BrandMark
                  className="h-8 w-8 bg-transparent border-white/20 text-white"
                  title={BRAND.name}
                />
              </div>
              <div className="text-left">
                <div className="text-xs text-white/70">Verified by</div>
                <div className="text-lg font-black text-white leading-tight">
                  {order.business_name || BRAND.name}
                </div>
              </div>
            </div>

            <div className="mt-4 flex flex-col items-center gap-2">
              <div className="text-[11px] text-white/70 uppercase tracking-widest">
                Receipt Number
              </div>
              <div className="font-mono text-white text-xl sm:text-2xl font-black">
                {order.receipt_number}
              </div>

              <Badge
                variant="outline"
                className={cn(
                  "mt-1 border-white/20 bg-white/10 text-white",
                  isCompleted && "border-emerald-200/30 bg-emerald-200/10 text-emerald-50"
                )}
              >
                <StatusIcon className="w-3.5 h-3.5 mr-2" />
                {status.toUpperCase()} • {String(order.payment_method || "cash").toUpperCase()}
              </Badge>
            </div>
          </div>

          {/* BODY */}
          <CardContent className="p-5 sm:p-6 bg-slate-950/40">
            {/* META */}
            <div className="grid grid-cols-2 gap-3 text-sm">
              <Meta label="Date" value={new Date(order.created_at).toLocaleDateString()} right />
              <Meta
                label="Time"
                value={new Date(order.created_at).toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
                right
              />
              <Meta label="Cashier" value={order.cashier_name || "Staff"} />
              <Meta label="Customer" value={"Walk-in"} right={false} full />
            </div>

            <div className="mt-4">
              <div className="text-[11px] text-slate-400 mb-1">receipt_id</div>
              <div className="text-xs font-mono break-all rounded-xl border border-slate-800 bg-slate-950/60 px-3 py-2 text-slate-200">
                {order.receipt_id}
              </div>
            </div>

            <Separator className="my-5 bg-slate-800" />

            {/* ITEMS */}
            <div>
              <div className="flex items-center justify-between mb-3">
                <div className="text-sm font-semibold text-white">Items</div>
                <div className="text-xs text-slate-400">
                  {order.items?.length || 0} line(s)
                </div>
              </div>

              <div className="space-y-2">
                {(order.items || []).map((it, idx) => {
                  const line = Number(it.price_at_sale || 0) * Number(it.quantity || 0);
                  return (
                    <div
                      key={`${it.product_name}-${idx}`}
                      className="flex items-start justify-between gap-3 rounded-xl border border-slate-800 bg-slate-900/40 px-3 py-2"
                    >
                      <div className="min-w-0">
                        <div className="text-slate-100 font-medium truncate">
                          {it.product_name}
                        </div>
                        <div className="text-[11px] text-slate-400">
                          {it.quantity} × {money(it.price_at_sale)}
                        </div>
                      </div>
                      <div className="font-mono font-semibold text-slate-100">
                        {money(line)}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            <Separator className="my-5 bg-slate-800" />

            {/* TOTAL */}
            <div className="rounded-2xl border border-slate-800 bg-slate-900/50 p-4 flex items-center justify-between">
              <div>
                <div className="text-[11px] text-slate-400 uppercase tracking-wider">
                  Total
                </div>
                <div className="text-xs text-slate-500">
                  {isCompleted ? "Paid" : "Not confirmed"}
                </div>
              </div>
              <div className="text-3xl font-black text-white font-mono">
                {money(order.total_amount)}
              </div>
            </div>

            {/* FOOTER */}
            <div className="pt-5 text-center">
              <div className="text-[10px] text-slate-500 uppercase tracking-[0.25em]">
                Digital Verification System
              </div>
              <div className="mt-2 text-[11px] text-slate-400">
                If this looks wrong, contact the store with the receipt number above.
              </div>
            </div>
          </CardContent>
        </Card>
      </motion.div>
    </div>
  );
};

/* ---------------- helpers ---------------- */

function Meta({
  label,
  value,
  right,
  full,
}: {
  label: string;
  value: string;
  right?: boolean;
  full?: boolean;
}) {
  return (
    <div className={cn("flex flex-col", full && "col-span-2")}>
      <span className="text-[11px] text-slate-400 uppercase tracking-wider font-semibold">
        {label}
      </span>
      <span className={cn("text-slate-100 font-medium", right && "text-right")}>
        {value}
      </span>
    </div>
  );
}
