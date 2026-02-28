import { BRAND } from "@/lib/brand";
import { buildVerifyUrl } from "@/lib/verifyUrl";

type DiscountType = "percentage" | "fixed";

export type ReceiptStoreSettings = {
  business_name?: string | null;
  address?: string | null;
  phone?: string | null;
  tax_id?: string | null;
  footer_message?: string | null;
  show_qr_code?: boolean | null;
  qr_code_data?: string | null;
};

export type ReceiptCartLineInput = {
  lineId?: string | null;
  product?: {
    id?: string | null;
    name?: string | null;
    price?: number | string | null;
  } | null;
  quantity?: number | string | null;
  customPrice?: number | string | null;
  discount?: number | string | null;
  discountType?: DiscountType | null;
  customDescription?: string | null;
};

export type ReceiptPrintModelInput = {
  cart: ReceiptCartLineInput[];
  cashierName: string;
  customerName?: string | null;
  receiptId: string;
  receiptNumber: string;
  paymentMethod: string;
  subtotal: number;
  discount: number;
  tax: number;
  total: number;
  activeDiscount?: { name?: string | null } | null;
  taxRatePct?: number | null;
  timestamp?: string | Date | null;
  settings?: ReceiptStoreSettings | null;
};

export type ReceiptLineSummary = {
  key: string;
  name: string;
  qty: number;
  unit: number;
  lineTotal: number;
  discountType: DiscountType;
  discountValue: number;
  lineDiscount: number;
  impliedPercent: number | null;
  finalLine: number;
  customDescription: string;
};

export type ReceiptPrintModel = {
  header: {
    logoUrl?: string;
    logoAlt: string;
    logoMaxWidthPx?: number;
    logoMaxHeightPx?: number;
    brandTitleLines: string[];
    brandSupportLine?: string;
    businessName: string;
    address?: string;
    phone?: string;
    taxId?: string;
  };
  meta: {
    dateLabel: string;
    timeLabel: string;
    timestampIso: string;
    cashierName: string;
    customerName: string;
    receiptId: string;
    receiptNumber: string;
    paymentMethod: string;
  };
  items: ReceiptLineSummary[];
  totals: {
    subtotal: number;
    discount: number;
    tax: number;
    total: number;
    showTax: boolean;
    showGlobalDiscount: boolean;
    activeDiscountName?: string | null;
    taxRatePct?: number | null;
  };
  verification: {
    showQrCode: boolean;
    payload: string;
  };
  footer: {
    footerMessage?: string;
    poweredByLine: string;
  };
};

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

function toFiniteNumber(n: unknown) {
  const v = Number(n);
  return Number.isFinite(v) ? v : 0;
}

function normalizeTimestamp(value: ReceiptPrintModelInput["timestamp"]) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : new Date();
  if (typeof value === "string" && value.trim()) {
    const parsed = new Date(value);
    if (Number.isFinite(parsed.getTime())) return parsed;
  }
  return new Date();
}

function safeString(value: unknown, fallback = "") {
  const s = String(value ?? "").trim();
  return s || fallback;
}

function buildLineSummaries(cart: ReceiptCartLineInput[]): ReceiptLineSummary[] {
  return (cart || []).map((item) => {
    const unit = toFiniteNumber(item.customPrice ?? item.product?.price ?? 0);
    const qty = toFiniteNumber(item.quantity ?? 0);
    const lineTotal = unit * qty;

    const dType = (item.discountType ?? "percentage") as DiscountType;
    const dVal = toFiniteNumber(item.discount ?? 0);
    const lineDiscount = dVal > 0 ? (dType === "percentage" ? lineTotal * (dVal / 100) : dVal) : 0;
    const safeLineDiscount = round2(Math.max(0, Math.min(lineDiscount, lineTotal)));
    const finalLine = round2(lineTotal - safeLineDiscount);
    const impliedPercent =
      dType === "fixed" && lineTotal > 0 ? round2((safeLineDiscount / lineTotal) * 100) : null;

    return {
      key: safeString(item.lineId, safeString(item.product?.id, `line-${Math.random().toString(16).slice(2)}`)),
      name: safeString(item.product?.name, "Item"),
      qty,
      unit,
      lineTotal: round2(lineTotal),
      discountType: dType,
      discountValue: round2(dVal),
      lineDiscount: safeLineDiscount,
      impliedPercent,
      finalLine,
      customDescription: safeString(item.customDescription),
    };
  });
}

export function buildReceiptPrintModel(input: ReceiptPrintModelInput): ReceiptPrintModel {
  const ts = normalizeTimestamp(input.timestamp);
  const settings = input.settings || {};
  const items = buildLineSummaries(input.cart || []);
  const receiptId = safeString(input.receiptId, "unknown-receipt");
  const receiptNumber = safeString(input.receiptNumber, "N/A");

  return {
    header: {
      logoUrl: BRAND.receiptLogoUrl,
      logoAlt: BRAND.receiptLogoAlt || BRAND.name,
      logoMaxWidthPx: BRAND.receiptLogoMaxWidthPx,
      logoMaxHeightPx: BRAND.receiptLogoMaxHeightPx,
      brandTitleLines: BRAND.receiptTitleLines || [],
      brandSupportLine: BRAND.supportLine,
      businessName: safeString(settings.business_name, "Your Business"),
      address: safeString(settings.address) || undefined,
      phone: safeString(settings.phone) || undefined,
      taxId: safeString(settings.tax_id) || undefined,
    },
    meta: {
      dateLabel: ts.toLocaleDateString(),
      timeLabel: ts.toLocaleTimeString(),
      timestampIso: ts.toISOString(),
      cashierName: safeString(input.cashierName, "Staff"),
      customerName: safeString(input.customerName, "Walk-in"),
      receiptId,
      receiptNumber,
      paymentMethod: safeString(input.paymentMethod, "cash"),
    },
    items,
    totals: {
      subtotal: toFiniteNumber(input.subtotal),
      discount: toFiniteNumber(input.discount),
      tax: toFiniteNumber(input.tax),
      total: toFiniteNumber(input.total),
      showTax: toFiniteNumber(input.tax) > 0,
      showGlobalDiscount: toFiniteNumber(input.discount) > 0,
      activeDiscountName: input.activeDiscount?.name || null,
      taxRatePct: input.taxRatePct ?? null,
    },
    verification: {
      showQrCode: settings.show_qr_code !== false,
      payload: buildVerifyUrl(settings.qr_code_data, receiptId),
    },
    footer: {
      footerMessage: safeString(settings.footer_message) || undefined,
      poweredByLine: "Powered by BinanceXI",
    },
  };
}
