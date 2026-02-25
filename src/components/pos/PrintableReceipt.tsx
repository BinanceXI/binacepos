// File: src/components/pos/PrintableReceipt.tsx
import { forwardRef, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { QRCodeSVG } from "qrcode.react";
import type { CartItem, Discount } from "@/types/pos";
import { buildReceiptPrintModel, type ReceiptStoreSettings } from "@/core/receipts/receiptPrintModel";

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
  timestamp?: string;
  settingsOverride?: ReceiptStoreSettings | null;
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
    timestamp,
    settingsOverride,
  } = props;

  const { data: settings } = useQuery({
    queryKey: ["storeSettings"],
    queryFn: async () => {
      const { data, error } = await supabase.from("store_settings").select("*").maybeSingle();
      if (error) throw error;
      return data || {};
    },
    staleTime: 1000 * 60 * 60,
    enabled: !settingsOverride,
  });

  const effectiveSettings = useMemo(
    () => (settingsOverride ?? (settings as ReceiptStoreSettings | undefined) ?? {}) as ReceiptStoreSettings,
    [settingsOverride, settings]
  );

  const model = useMemo(
    () =>
      buildReceiptPrintModel({
        cart: (cart || []) as any,
        cashierName,
        customerName,
        receiptId,
        receiptNumber,
        paymentMethod,
        subtotal,
        discount,
        tax,
        total,
        activeDiscount: activeDiscount as any,
        taxRatePct,
        timestamp,
        settings: effectiveSettings,
      }),
    [
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
      timestamp,
      effectiveSettings,
    ]
  );

  return (
    <div
      ref={ref}
      className="w-[58mm] p-2 text-black font-mono text-[11px] leading-tight bg-white"
      style={{ WebkitPrintColorAdjust: "exact", printColorAdjust: "exact" as any }}
    >
      {/* HEADER */}
      <div className="text-center mb-2">
        {model.header.logoUrl ? (
          <div className="mb-1 flex justify-center">
            <img
              src={model.header.logoUrl}
              alt={model.header.logoAlt}
              style={{
                maxWidth: `${model.header.logoMaxWidthPx ?? 148}px`,
                maxHeight: `${model.header.logoMaxHeightPx ?? 34}px`,
              }}
              className="h-auto object-contain"
            />
          </div>
        ) : null}
        <div className="mb-1">
          <div className="font-black text-[12px] uppercase tracking-[0.22em] leading-none">
            {model.header.brandTitleLines.map((line) => (
              <div key={line}>{line}</div>
            ))}
          </div>
          {model.header.brandSupportLine ? (
            <div className="text-[8px] font-bold uppercase mt-1">{model.header.brandSupportLine}</div>
          ) : null}
        </div>

        <h2 className="font-black text-[18px] uppercase leading-none mb-0.5">
          {model.header.businessName}
        </h2>

        {model.header.address ? <p className="text-[9px]">{model.header.address}</p> : null}
        {model.header.phone ? <p className="text-[9px]">{model.header.phone}</p> : null}
        {model.header.taxId ? <p className="text-[9px] font-bold mt-0.5">TAX: {model.header.taxId}</p> : null}
      </div>

      <div className="border-b border-dashed border-black my-2" />

      {/* META */}
      <div className="text-[9px] uppercase mb-2">
        <div className="flex justify-between">
          <div>
            <div>{model.meta.dateLabel}</div>
            <div>{model.meta.timeLabel}</div>
          </div>
          <div className="text-right">
            <div className="font-bold">#{model.meta.receiptNumber}</div>
            <div>Staff: {model.meta.cashierName}</div>
          </div>
        </div>

        <div className="text-center font-bold border border-black py-1 mt-2">
          Customer: {model.meta.customerName}
        </div>
      </div>

      <div className="border-b border-dashed border-black my-2" />

      {/* ITEMS */}
      <div className="space-y-2 mb-3">
        {model.items.map((it) => (
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
          <span>{fmtMoney(model.totals.subtotal)}</span>
        </div>

        {model.totals.showGlobalDiscount ? (
          <div className="flex justify-between text-[11px]">
            <span>Discount{model.totals.activeDiscountName ? ` (${model.totals.activeDiscountName})` : ""}</span>
            <span>-{fmtMoney(model.totals.discount)}</span>
          </div>
        ) : null}

        {model.totals.showTax ? (
          <div className="flex justify-between text-[11px]">
            <span>Tax{typeof model.totals.taxRatePct === "number" ? ` (${model.totals.taxRatePct}%)` : ""}</span>
            <span>{fmtMoney(model.totals.tax)}</span>
          </div>
        ) : null}

        <div className="border-t border-black pt-1 mt-1" />

        <div className="flex justify-between font-black text-[16px]">
          <span>TOTAL</span>
          <span>{fmtMoney(model.totals.total)}</span>
        </div>

        <div className="text-center text-[10px] mt-2 uppercase">
          Paid via {model.meta.paymentMethod}
        </div>
      </div>

      {/* QR + FOOTER */}
      <div className="mt-4 text-center space-y-1">
        {model.verification.showQrCode ? (
          <div className="flex flex-col items-center">
            <QRCodeSVG value={model.verification.payload} size={92} />
            <div className="text-[8px] mt-1">Scan to Verify</div>
            <div className="text-[8px] opacity-70 break-all">ID: {model.meta.receiptId}</div>
          </div>
        ) : null}

        {model.footer.footerMessage ? (
          <div className="text-[9px] uppercase px-1 whitespace-pre-wrap">{model.footer.footerMessage}</div>
        ) : null}

        <div className="text-[8px] font-bold mt-2">{model.footer.poweredByLine}</div>
      </div>
    </div>
  );
});

PrintableReceipt.displayName = "PrintableReceipt";
