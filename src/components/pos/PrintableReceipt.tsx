// File: src/components/pos/PrintableReceipt.tsx
import { forwardRef, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { QRCodeSVG } from "qrcode.react";
import type { CartItem, Discount } from "@/types/pos";
import { buildVerifyUrl } from "@/lib/verifyUrl";
import { BRAND } from "@/lib/brand";

type DiscountType = "percentage" | "fixed";

interface ReceiptProps {
  cart: CartItem[];
  cashierName: string;
  customerName?: string;

  receiptId: string;
  receiptNumber: string;
  paymentMethod: string;

  subtotal: number;
  discount: number;
  tax: number;
  total: number;

  activeDiscount?: Discount | null;
  taxRatePct?: number;
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

function fmtMoney(n: number) {
  const x = Number.isFinite(n) ? n : 0;
  return `$${x.toFixed(2)}`;
}

export const PrintableReceipt = forwardRef<HTMLDivElement, ReceiptProps>((props, ref) => {
  const {
    cart,
    cashierName,
    customerName,
    receiptId,
    receiptNumber,
    paymentMethod,
    subtotal,
    discount,
    tax,
    total,
    activeDiscount,
    taxRatePct,
  } = props;

  const { data: settings } = useQuery({
    queryKey: ["storeSettings"],
    queryFn: async () => {
      const { data, error } = await supabase.from("store_settings").select("*").maybeSingle();
      if (error) throw error;
      return data || {};
    },
    staleTime: 1000 * 60 * 60,
  });

  const origin =
    typeof window !== "undefined" && window.location?.origin ? window.location.origin : "https://binancexi-pos.app";

  const baseUrl = (settings as any)?.qr_code_data || origin;
  const qrUrl = buildVerifyUrl(baseUrl, receiptId);

  const now = useMemo(() => new Date(), [receiptId]);

  const lineSummaries = useMemo(() => {
    return (cart || []).map((item: any) => {
      const unit = Number(item.customPrice ?? item.product?.price ?? 0);
      const qty = Number(item.quantity ?? 0);
      const lineTotal = unit * qty;

      const dType = (item.discountType as DiscountType | undefined) ?? "percentage";
      const dVal = Number(item.discount ?? 0);

      const lineDiscount = dVal > 0 ? (dType === "percentage" ? lineTotal * (dVal / 100) : dVal) : 0;
      const safeLineDiscount = round2(Math.max(0, Math.min(lineDiscount, lineTotal)));
      const finalLine = round2(lineTotal - safeLineDiscount);

      const impliedPercent =
        dType === "fixed" && lineTotal > 0 ? round2((safeLineDiscount / lineTotal) * 100) : null;

      return {
        key: item.lineId || `${item.product?.id}-${Math.random()}`,
        name: item.product?.name ?? "Item",
        qty,
        unit,
        lineTotal: round2(lineTotal),
        discountType: dType,
        discountValue: round2(dVal),
        lineDiscount: safeLineDiscount,
        impliedPercent,
        finalLine,
        customDescription: item.customDescription || "",
      };
    });
  }, [cart]);

  const showTax = Number(tax || 0) > 0;
  const showGlobalDiscount = Number(discount || 0) > 0;

  return (
    <div
      ref={ref}
      className="w-[58mm] p-2 text-black font-mono text-[11px] leading-tight bg-white"
      style={{ WebkitPrintColorAdjust: "exact", printColorAdjust: "exact" as any }}
    >
      {/* HEADER */}
      <div className="text-center mb-2">
        <div className="mb-1">
          <div className="font-black text-[12px] uppercase tracking-[0.22em] leading-none">
            {BRAND.receiptTitleLines.map((line) => (
              <div key={line}>{line}</div>
            ))}
          </div>
          {BRAND.supportLine ? (
            <div className="text-[8px] font-bold uppercase mt-1">{BRAND.supportLine}</div>
          ) : null}
        </div>

        <h2 className="font-black text-[18px] uppercase leading-none mb-0.5">
          {(settings as any)?.business_name || "Your Business"}
        </h2>

        {(settings as any)?.address ? <p className="text-[9px]">{(settings as any).address}</p> : null}
        {(settings as any)?.phone ? <p className="text-[9px]">{(settings as any).phone}</p> : null}
        {(settings as any)?.tax_id ? <p className="text-[9px] font-bold mt-0.5">TAX: {(settings as any).tax_id}</p> : null}
      </div>

      <div className="border-b border-dashed border-black my-2" />

      {/* META */}
      <div className="text-[9px] uppercase mb-2">
        <div className="flex justify-between">
          <div>
            <div>{now.toLocaleDateString()}</div>
            <div>{now.toLocaleTimeString()}</div>
          </div>
          <div className="text-right">
            <div className="font-bold">#{receiptNumber}</div>
            <div>Staff: {cashierName}</div>
          </div>
        </div>

        <div className="text-center font-bold border border-black py-1 mt-2">
          Customer: {customerName?.trim() ? customerName : "Walk-in"}
        </div>
      </div>

      <div className="border-b border-dashed border-black my-2" />

      {/* ITEMS */}
      <div className="space-y-2 mb-3">
        {lineSummaries.map((it) => (
          <div key={it.key}>
            {/* ✅ item name on its own line (cleaner on 58mm) */}
            <div className="text-[11px] font-bold break-words">{it.name}</div>

            {/* ✅ qty x unit on left, line total on right */}
            <div className="flex justify-between text-[10px]">
              <span>
                {it.qty} x {fmtMoney(it.unit)}
              </span>
              <span>{fmtMoney(it.lineTotal)}</span>
            </div>

            {/* ✅ item discount */}
            {it.lineDiscount > 0 ? (
              <div className="flex justify-between text-[9px]">
                <span>
                  Disc{" "}
                  {it.discountType === "percentage"
                    ? `(${it.discountValue}%)`
                    : it.impliedPercent !== null
                      ? `(${it.discountValue}$ ~${it.impliedPercent}%)`
                      : `(${it.discountValue}$)`}
                </span>
                <span>-{fmtMoney(it.lineDiscount)}</span>
              </div>
            ) : null}

            {/* ✅ line total after discount */}
            {it.lineDiscount > 0 ? (
              <div className="flex justify-between text-[9px] font-bold">
                <span>Line Total</span>
                <span>{fmtMoney(it.finalLine)}</span>
              </div>
            ) : null}

            {it.customDescription ? <div className="text-[9px] italic pl-1">- {it.customDescription}</div> : null}
          </div>
        ))}
      </div>

      <div className="border-b border-dashed border-black my-2" />

      {/* TOTALS */}
      <div className="space-y-1">
        <div className="flex justify-between text-[11px]">
          <span>Subtotal</span>
          <span>{fmtMoney(subtotal)}</span>
        </div>

        {showGlobalDiscount ? (
          <div className="flex justify-between text-[11px]">
            <span>Discount{activeDiscount?.name ? ` (${activeDiscount.name})` : ""}</span>
            <span>-{fmtMoney(discount)}</span>
          </div>
        ) : null}

        {showTax ? (
          <div className="flex justify-between text-[11px]">
            <span>Tax{typeof taxRatePct === "number" ? ` (${taxRatePct}%)` : ""}</span>
            <span>{fmtMoney(tax)}</span>
          </div>
        ) : null}

        <div className="border-t border-black pt-1 mt-1" />

        <div className="flex justify-between font-black text-[16px]">
          <span>TOTAL</span>
          <span>{fmtMoney(total)}</span>
        </div>

        <div className="text-center text-[10px] mt-2 uppercase">
          Paid via {paymentMethod}
        </div>
      </div>

      {/* QR + FOOTER */}
      <div className="mt-4 text-center space-y-1">
        {(settings as any)?.show_qr_code !== false ? (
          <div className="flex flex-col items-center">
            <QRCodeSVG value={qrUrl} size={92} />
            <div className="text-[8px] mt-1">Scan to Verify</div>
            <div className="text-[8px] opacity-70 break-all">ID: {receiptId}</div>
          </div>
        ) : null}

        {(settings as any)?.footer_message ? (
          <div className="text-[9px] uppercase px-1 whitespace-pre-wrap">{(settings as any).footer_message}</div>
        ) : null}

        <div className="text-[8px] font-bold mt-2">POWERED BY BINANCE LABS</div>
      </div>
    </div>
  );
});

PrintableReceipt.displayName = "PrintableReceipt";
