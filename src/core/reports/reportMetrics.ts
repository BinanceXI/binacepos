import { format, isWithinInterval, parseISO } from "date-fns";
import { readScopedJSON, resolveTenantScope, writeScopedJSON } from "@/lib/tenantScope";

export const OFFLINE_QUEUE_KEY = "binancexi_offline_queue";
export const ORDERS_CACHE_KEY = "binancexi_orders_cache_v1";

export type OrderItemRow = {
  quantity: number;
  price_at_sale: number;
  product_name: string;
  service_note?: string | null;
};

export type OrderRow = {
  id: string;
  receipt_id?: string | null;
  receipt_number?: string | null;
  total_amount: number;
  payment_method: string | null;
  status?: string | null;
  created_at: string;
  cashier_id?: string | null;
  sale_type?: string | null;
  booking_id?: string | null;
  profiles?: { full_name?: string | null } | null;
  order_items?: OrderItemRow[] | null;
};

type TenantScope = ReturnType<typeof resolveTenantScope>;

export type SalesRangeType = "today" | "week" | "month" | "year" | "custom";

export function readOrdersCache(scope: TenantScope): OrderRow[] {
  return readScopedJSON<OrderRow[]>(ORDERS_CACHE_KEY, [], {
    scope,
    migrateLegacy: true,
  });
}

function writeOrdersCache(scope: TenantScope, rows: OrderRow[]) {
  writeScopedJSON(ORDERS_CACHE_KEY, rows, { scope });
}

export function upsertOrdersCache(scope: TenantScope, rows: OrderRow[]) {
  const cur = readOrdersCache(scope);
  const byId = new Map<string, OrderRow>();
  for (const o of cur) {
    if (o?.id) byId.set(String(o.id), o);
  }
  for (const o of rows) {
    if (o?.id) byId.set(String(o.id), o);
  }

  const merged = Array.from(byId.values()).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  writeOrdersCache(scope, merged.slice(0, 3000));
}

export function offlineQueueToOrders(scope: TenantScope): OrderRow[] {
  const queue = readScopedJSON<any[]>(OFFLINE_QUEUE_KEY, [], {
    scope,
    migrateLegacy: true,
  });
  return (queue || [])
    .map((sale: any) => {
      const created_at = String(sale?.meta?.timestamp || new Date().toISOString());
      const items = Array.isArray(sale?.items) ? sale.items : [];
      const saleType =
        String(sale?.saleType || sale?.meta?.saleType || "").trim() ||
        (items.some((i: any) => i?.product?.type === "service") ? "service" : "product");

      const bookingId = sale?.bookingId ?? sale?.meta?.bookingId ?? null;

      return {
        id: String(sale?.meta?.receiptId || `offline-${created_at}`),
        receipt_id: String(sale?.meta?.receiptId || ""),
        receipt_number: String(sale?.meta?.receiptNumber || ""),
        total_amount: Number(sale?.total || 0),
        payment_method: String(sale?.payments?.[0]?.method || "cash"),
        status: "completed",
        created_at,
        sale_type: saleType,
        booking_id: bookingId ? String(bookingId) : null,
        profiles: { full_name: "Offline" },
        order_items: items.map((i: any) => ({
          quantity: Number(i?.quantity || 0),
          price_at_sale: Number(i?.customPrice ?? i?.product?.price ?? 0),
          product_name: String(i?.product?.name || "Unknown"),
          service_note: i?.customDescription ? String(i.customDescription) : null,
        })),
      } as OrderRow;
    })
    .filter(Boolean);
}

export function inRange(iso: string, start: Date, end: Date) {
  try {
    return isWithinInterval(parseISO(iso), { start, end });
  } catch {
    return false;
  }
}

export function mergeOrdersForMetrics(...groups: Array<OrderRow[] | undefined | null>) {
  const byId = new Map<string, OrderRow>();
  const withoutId: OrderRow[] = [];
  for (const group of groups) {
    for (const row of group || []) {
      if (!row) continue;
      const id = String(row.id || "").trim();
      if (!id) {
        withoutId.push(row);
        continue;
      }
      byId.set(id, row);
    }
  }
  return [...Array.from(byId.values()), ...withoutId].sort((a, b) =>
    String(a.created_at).localeCompare(String(b.created_at))
  );
}

export function sumOrdersRevenue(rows: OrderRow[]) {
  return (rows || []).reduce((sum, row) => sum + Number(row?.total_amount || 0), 0);
}

export function calculateMonthExpenseTotals(monthExpenses: any[], monthRevenue: number) {
  let expenses = 0;
  let drawings = 0;
  (monthExpenses || []).forEach((e: any) => {
    const amt = Number(e.amount || 0);
    if (e.expense_type === "owner_draw" || e.expense_type === "owner_drawing") drawings += amt;
    else expenses += amt;
  });
  const net = Number(monthRevenue || 0) - (expenses + drawings);
  return { expenses, drawings, net };
}

export function calculateSalesStats(salesData: OrderRow[], rangeType: SalesRangeType) {
  let totalRevenue = 0;
  let transactionCount = 0;
  const paymentMethods = { cash: 0, card: 0, ecocash: 0 };
  const cashierPerformance: Record<string, number> = {};
  const chartData: Array<{ name: string; value: number }> = [];
  const productSales: Record<string, number> = {};
  const timeMap: Record<string, number> = {};

  (salesData || []).forEach((order: any) => {
    const amount = Number(order.total_amount || 0);
    totalRevenue += amount;
    transactionCount += 1;

    const method = String(order.payment_method || "cash").toLowerCase();
    if (method.includes("card") || method.includes("swipe")) paymentMethods.card += amount;
    else if (method.includes("eco") || method.includes("mobile")) paymentMethods.ecocash += amount;
    else paymentMethods.cash += amount;

    const cashierName = order.profiles?.full_name || "Unknown";
    cashierPerformance[cashierName] = (cashierPerformance[cashierName] || 0) + amount;

    (order.order_items || []).forEach((item: any) => {
      const pName = item.product_name || "Unknown";
      productSales[pName] = (productSales[pName] || 0) + Number(item.quantity || 0);
    });

    try {
      const date = parseISO(order.created_at);
      let key = format(date, "HH:00");
      if (rangeType === "month" || rangeType === "year" || rangeType === "week") key = format(date, "MMM dd");
      timeMap[key] = (timeMap[key] || 0) + amount;
    } catch {
      // skip invalid timestamps
    }
  });

  Object.keys(timeMap).forEach((key) => chartData.push({ name: key, value: timeMap[key] }));

  const avgTicket = transactionCount > 0 ? totalRevenue / transactionCount : 0;
  const topProducts = Object.entries(productSales)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5)
    .map(([name, qty]) => ({ name, qty }));

  const topCashiers = Object.entries(cashierPerformance)
    .sort(([, a], [, b]) => b - a)
    .map(([name, total]) => ({ name, total }));

  return {
    totalRevenue,
    transactionCount,
    avgTicket,
    paymentMethods,
    chartData,
    topProducts,
    topCashiers,
  };
}
