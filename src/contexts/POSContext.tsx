// File: src/contexts/POSContext.tsx
import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  ReactNode,
  useCallback,
} from "react";
import type { CartItem, Product, SyncStatus, Sale, POSMode, Discount } from "@/types/pos";
import { supabase } from "@/lib/supabase";
import { ensureSupabaseSession } from "@/lib/supabaseSession";
import { readScopedJSON, resolveTenantScope, tenantScopeKey, writeScopedJSON } from "@/lib/tenantScope";
import { isAdminLikeRole } from "@/lib/roles";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { getExpenseQueueCount, syncExpenses } from "@/lib/expenses";
import { getInventoryQueueCount, processInventoryQueue } from "@/lib/inventorySync";
import {
  getUnsyncedServiceBookingsCount,
  pullRecentServiceBookings,
  pushUnsyncedServiceBookings,
} from "@/lib/serviceBookings";

/* ---------------------------------- USER TYPES --------------------------------- */
export type Role = "platform_admin" | "master_admin" | "super_admin" | "admin" | "cashier";

export type UserPermissions = {
  allowRefunds: boolean;
  allowVoid: boolean;
  allowPriceEdit: boolean;
  allowDiscount: boolean;
  allowServiceBookings: boolean;
  allowReports: boolean;
  allowInventory: boolean;
  allowSettings: boolean;
  allowEditReceipt: boolean;
};

export type POSUser = {
  id: string;
  username: string;
  role: Role;
  permissions: UserPermissions;
  business_id?: string | null;

  // convenience
  full_name?: string;
  name?: string;
  active?: boolean;
};

export const ADMIN_PERMISSIONS: UserPermissions = {
  allowRefunds: true,
  allowVoid: true,
  allowPriceEdit: true,
  allowDiscount: true,
  allowServiceBookings: true,
  allowReports: true,
  allowInventory: true,
  allowSettings: true,
  allowEditReceipt: true,
};

export const CASHIER_DEFAULT_PERMISSIONS: UserPermissions = {
  allowRefunds: false,
  allowVoid: false,
  allowPriceEdit: false,
  allowDiscount: false,
  allowServiceBookings: false,
  allowReports: false,
  allowInventory: false,
  allowSettings: false,
  allowEditReceipt: false,
};

/* ---------------------------------- TYPES --------------------------------- */

export type SaleMeta = {
  receiptId: string;
  receiptNumber: string;
  timestamp: string;
  saleType?: "product" | "service";
  bookingId?: string | null;
};

type Payment = { method: string; amount: number };

type SaleType = "product" | "service";

type OfflineSale = {
  cashierId: string;
  customerName: string;
  total: number;
  payments: Payment[];
  items: CartItem[];
  meta: SaleMeta;
  saleType?: SaleType;
  bookingId?: string | null;
  synced: boolean;
  lastError?: string;
};

interface POSContextType {
  currentUser: POSUser | null;
  setCurrentUser: (user: POSUser | null) => void;

  can: (permission: keyof UserPermissions) => boolean;

  cart: CartItem[];
  addToCart: (product: Product, customDescription?: string, customPrice?: number) => boolean;
  removeFromCart: (lineId: string) => void;
  updateCartItemQuantity: (lineId: string, quantity: number) => void;
  updateCartItemCustom: (lineId: string, customDescription?: string, customPrice?: number) => void;
  updateCartItemDiscount: (
    lineId: string,
    discount: number,
    discountType: "percentage" | "fixed"
  ) => void;
  clearCart: () => void;

  syncStatus: SyncStatus;
  setSyncStatus: (status: SyncStatus) => void;
  pendingSyncCount: number;

  heldSales: Sale[];
  holdCurrentSale: () => void;
  resumeSale: (saleId: string) => void;

  selectedCategory: string | null;
  setSelectedCategory: (category: string | null) => void;

  posMode: POSMode;
  setPosMode: (mode: POSMode) => void;

  customerName: string;
  setCustomerName: (name: string) => void;

  activeDiscount: Discount | null;
  setActiveDiscount: (discount: Discount | null) => void;
  applyDiscountCode: (code: string) => boolean;

  completeSale: (payments: Payment[], total: number, meta: SaleMeta) => Promise<void>;
  recordSaleByItems: (args: {
    items: CartItem[];
    payments: Payment[];
    total: number;
    meta: SaleMeta;
    customerName?: string;
  }) => Promise<void>;

  getSecureTime: () => Date;
}

/* -------------------------------- CONTEXT --------------------------------- */

const POSContext = createContext<POSContextType | undefined>(undefined);

export const usePOS = () => {
  const ctx = useContext(POSContext);
  if (!ctx) throw new Error("usePOS must be used within a POSProvider");
  return ctx;
};

/* ----------------------------- STORAGE KEYS -------------------------------- */

const OFFLINE_QUEUE_KEY = "binancexi_offline_queue";
const HELD_SALES_KEY = "binancexi_held_sales";
const USER_KEY = "binancexi_user";

/* -------------------------------- HELPERS ---------------------------------- */

const newLineId = () => `line-${Date.now()}-${Math.random().toString(16).slice(2)}`;

const ensureLineIds = (items: any[]): CartItem[] =>
  (items || []).map((it: any) => ({
    ...it,
    lineId: it.lineId || newLineId(),
    discountType: it.discountType || "percentage",
    discount: typeof it.discount === "number" ? it.discount : 0,
  }));

  const safeJSONParse = <T,>(raw: string | null, fallback: T): T => {
    if (!raw) return fallback;
    try {
      return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
};

const errorToMessage = (err: any) => {
  if (!err) return "Unknown error";

  // Supabase/PostgREST errors usually have: message, details, hint, code, status
  const code = err?.code ? `code=${err.code}` : "";
  const status = err?.status ? `status=${err.status}` : "";
  const msg = err?.message || err?.error_description || "Request failed";
  const details = err?.details ? `details=${String(err.details)}` : "";
  const hint = err?.hint ? `hint=${String(err.hint)}` : "";

  const parts = [msg, code, status, details, hint].filter(Boolean);
  if (parts.length) return parts.join(" | ");

  return typeof err === "string" ? err : JSON.stringify(err);
};

const isUuid = (s: any) =>
  typeof s === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s);

const ensureUuid = (raw: any) => {
  const s = String(raw || "").trim();
  if (isUuid(s)) return s;
  // fallback for older devices / bad stored IDs
  return (globalThis.crypto as any)?.randomUUID?.() || `rcpt-${Date.now()}-${Math.random().toString(16).slice(2)}`;
};

const deriveSaleType = (items: CartItem[], fallback: SaleType = "product"): SaleType => {
  for (const it of items || []) {
    if ((it as any)?.product?.type === "service") return "service";
  }
  return fallback;
};

const isSaleTypeConstraintError = (err: any) => {
  const code = String(err?.code || "");
  const msg = String(err?.message || "");
  const details = String(err?.details || "");
  return code === "23514" || msg.includes("orders_sale_type_check") || details.includes("orders_sale_type_check");
};

const uniqueNonEmpty = (values: string[]) =>
  Array.from(new Set(values.map((v) => String(v || "").trim().toLowerCase()).filter(Boolean)));

async function detectProductLikeSaleTypeFromOrders(): Promise<string | null> {
  try {
    const { data, error } = await supabase
      .schema("public")
      .from("orders")
      .select("sale_type")
      .neq("sale_type", "service")
      .order("created_at", { ascending: false })
      .limit(25);

    if (error) return null;
    const found = (data || [])
      .map((r: any) => String(r?.sale_type || "").trim().toLowerCase())
      .find((v: string) => v && v !== "service");
    return found || null;
  } catch {
    return null;
  }
}

async function saleTypeCandidates(saleType: SaleType): Promise<string[]> {
  if (saleType === "service") return ["service"];

  const detected = await detectProductLikeSaleTypeFromOrders();
  return uniqueNonEmpty([
    detected || "",
    "product",
    "retail",
    "good",
    "goods",
  ]);
}

async function insertOrderWithSaleTypeFallback(
  baseOrderRow: Record<string, any>,
  saleType: SaleType
): Promise<{ id: string; saleTypeUsed: string }> {
  const candidates = await saleTypeCandidates(saleType);
  let lastErr: any = null;

  for (let i = 0; i < candidates.length; i += 1) {
    const candidate = candidates[i];
    const { data, error } = await supabase
      .schema("public")
      .from("orders")
      .insert({ ...baseOrderRow, sale_type: candidate })
      .select("id")
      .single();

    if (!error) return { id: String((data as any)?.id), saleTypeUsed: candidate };

    lastErr = error;
    const canRetry = isSaleTypeConstraintError(error) && i < candidates.length - 1;
    if (!canRetry) throw error;
  }

  throw lastErr || new Error("Failed to insert order");
}

  /* -------------------------- STOCK DECREMENT RPC ---------------------------- */

  const decrementStockForItems = async (items: CartItem[]) => {
    for (const item of items) {
    if (item.product?.type !== "good") continue;
    const qty = Number(item.quantity) || 0;
    if (qty <= 0) continue;

    const { error } = await supabase.rpc("decrement_stock", {
      p_product_id: item.product.id,
      p_qty: qty,
    });

    if (error) throw error;
  }
};

type StockRequestRow = {
  productId: string;
  productName: string;
  requestedQty: number;
};

function aggregateGoodsRequests(items: CartItem[]) {
  const reqByProduct = new Map<string, StockRequestRow>();
  for (const item of items || []) {
    if ((item as any)?.product?.type !== "good") continue;
    const productId = String((item as any)?.product?.id || "").trim();
    if (!productId) continue;
    const requestedQty = Math.max(0, Math.floor(Number((item as any)?.quantity || 0)));
    if (requestedQty <= 0) continue;

    const existing = reqByProduct.get(productId);
    if (!existing) {
      reqByProduct.set(productId, {
        productId,
        productName: String((item as any)?.product?.name || "Item"),
        requestedQty,
      });
      continue;
    }
    existing.requestedQty += requestedQty;
  }
  return Array.from(reqByProduct.values());
}

async function ensureStockAvailableForItems(items: CartItem[]) {
  const requested = aggregateGoodsRequests(items);
  if (!requested.length) return;

  const productIds = requested.map((r) => r.productId);
  const { data, error } = await supabase
    .from("products")
    .select("id, name, stock_quantity")
    .in("id", productIds);
  if (error) throw error;

  const stockByProductId = new Map<string, { name: string; stock: number }>();
  for (const row of data || []) {
    const id = String((row as any)?.id || "").trim();
    if (!id) continue;
    stockByProductId.set(id, {
      name: String((row as any)?.name || "Item"),
      stock: Math.max(0, Math.floor(Number((row as any)?.stock_quantity ?? 0))),
    });
  }

  for (const req of requested) {
    const row = stockByProductId.get(req.productId);
    if (!row) {
      throw new Error(`Insufficient stock: ${req.productName} is not available in this tenant.`);
    }
    if (row.stock < req.requestedQty) {
      throw new Error(
        `Insufficient stock: ${row.name} has ${row.stock}, requested ${req.requestedQty}.`
      );
    }
  }
}

function isInsufficientStockError(err: any) {
  const msg = String(err?.message || "").toLowerCase();
  return msg.includes("insufficient stock");
}

/* ------------------------------- PROVIDER ---------------------------------- */

export const POSProvider = ({ children }: { children: ReactNode }) => {
  const queryClient = useQueryClient();

  const [currentUser, _setCurrentUser] = useState<POSUser | null>(() => {
    const saved = localStorage.getItem(USER_KEY);
    if (!saved) return null;
    try {
      return JSON.parse(saved) as POSUser;
    } catch {
      localStorage.removeItem(USER_KEY);
      return null;
    }
  });
  const [cart, setCart] = useState<CartItem[]>([]);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>("online");

  const [heldSales, setHeldSales] = useState<Sale[]>([]);
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [posMode, setPosMode] = useState<POSMode>("retail");

  const [pendingSyncCount, setPendingSyncCount] = useState(0);
  const [customerName, setCustomerName] = useState("");
  const [activeDiscount, setActiveDiscount] = useState<Discount | null>(null);
  const [heldSalesReadyScopeKey, setHeldSalesReadyScopeKey] = useState("");

  const syncingRef = useRef(false);
  const globalSyncingRef = useRef(false);
  const lastCloudAuthNoticeRef = useRef<number>(0);

  /* --------------------------- SESSION PERSISTENCE -------------------------- */

  const setCurrentUser = (user: POSUser | null) => {
    const prevUser = currentUser;
    const prevScope = `${String(prevUser?.business_id || "")}:${String(prevUser?.id || "")}`;
    const nextScope = `${String(user?.business_id || "")}:${String(user?.id || "")}`;
    if (prevScope !== nextScope) {
      try {
        localStorage.removeItem("REACT_QUERY_OFFLINE_CACHE");
      } catch {
        // ignore
      }
      queryClient.clear();
    }
    _setCurrentUser(user);
    if (user) localStorage.setItem(USER_KEY, JSON.stringify(user));
    else localStorage.removeItem(USER_KEY);
  };

  const can = (permission: keyof UserPermissions) => {
    if (!currentUser) return false;
    if (isAdminLikeRole(currentUser.role)) return true;
    return !!currentUser.permissions?.[permission];
  };

  const getStorageScope = useCallback(
    () =>
      resolveTenantScope(
        currentUser
          ? {
              id: currentUser.id,
              business_id: currentUser.business_id,
            }
          : null
      ),
    [currentUser?.id, currentUser?.business_id]
  );

  const readSalesQueue = useCallback(
    () =>
      readScopedJSON<OfflineSale[]>(OFFLINE_QUEUE_KEY, [], {
        scope: getStorageScope(),
        migrateLegacy: true,
      }),
    [getStorageScope]
  );

  const writeSalesQueueStorage = useCallback(
    (queue: OfflineSale[]) => {
      writeScopedJSON(OFFLINE_QUEUE_KEY, queue, { scope: getStorageScope() });
    },
    [getStorageScope]
  );

  const readHeldSalesStorage = useCallback(
    () =>
      readScopedJSON<Sale[]>(HELD_SALES_KEY, [], {
        scope: getStorageScope(),
        migrateLegacy: true,
      }),
    [getStorageScope]
  );

  const writeHeldSalesStorage = useCallback(
    (sales: Sale[]) => {
      writeScopedJSON(HELD_SALES_KEY, sales, { scope: getStorageScope() });
    },
    [getStorageScope]
  );

  const getSalesQueueCount = useCallback(() => {
    try {
      const queue = readSalesQueue();
      return queue.length;
    } catch {
      return 0;
    }
  }, [readSalesQueue]);

  const refreshPendingSyncCount = useCallback(async () => {
    const sales = getSalesQueueCount();
    const inventory = getInventoryQueueCount();
    const expenses = getExpenseQueueCount();
    let bookings = 0;
    try {
      bookings = await getUnsyncedServiceBookingsCount();
    } catch {
      bookings = 0;
    }

    const total = sales + inventory + expenses + bookings;
    setPendingSyncCount(total);
    return { sales, inventory, expenses, bookings, total };
  }, [getSalesQueueCount]);

  /* ---------------------- LOAD HELD SALES & QUEUE --------------------------- */

  useEffect(() => {
    const scopeKey = tenantScopeKey(getStorageScope()) || "global";
    setHeldSalesReadyScopeKey("");
    const savedHeld = readHeldSalesStorage();
    setHeldSales(
      savedHeld.map((s: any) => ({
        ...s,
        items: ensureLineIds(s.items || []),
      }))
    );
    setHeldSalesReadyScopeKey(scopeKey);
    void refreshPendingSyncCount();
  }, [getStorageScope, readHeldSalesStorage, refreshPendingSyncCount]);

  useEffect(() => {
    const scopeKey = tenantScopeKey(getStorageScope()) || "global";
    if (heldSalesReadyScopeKey !== scopeKey) return;
    writeHeldSalesStorage(heldSales);
  }, [getStorageScope, heldSales, heldSalesReadyScopeKey, writeHeldSalesStorage]);

  const notifyQueueChanged = () => {
    try {
      window.dispatchEvent(new Event("binancexi:queue_changed"));
    } catch {
      // ignore
    }
  };

  const saveToOfflineQueue = (sale: OfflineSale) => {
    const queue = readSalesQueue();
    queue.push(sale);
    writeSalesQueueStorage(queue);
    notifyQueueChanged();
    void refreshPendingSyncCount();
  };

  const writeQueue = (queue: OfflineSale[]) => {
    writeSalesQueueStorage(queue);
    notifyQueueChanged();
    void refreshPendingSyncCount();
  };

  const annotateSalesQueueError = (msg: string) => {
    const message = String(msg || "").trim();
    if (!message) return;

    const queue = readSalesQueue();
    if (!queue.length) return;

    let changed = false;
    const next = queue.map((s) => {
      if (s.lastError) return s; // keep the original error if present
      changed = true;
      return { ...s, lastError: message };
    });

    if (changed) writeQueue(next);
  };

  const invalidateSalesQueries = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["products"] }),
      queryClient.invalidateQueries({ queryKey: ["receipts"] }),
      queryClient.invalidateQueries({ queryKey: ["dashboardStats"] }),
      queryClient.invalidateQueries({ queryKey: ["recentTx"] }),
      queryClient.invalidateQueries({ queryKey: ["salesReport"] }),
      queryClient.invalidateQueries({ queryKey: ["profitAnalysis"] }),
      queryClient.invalidateQueries({ queryKey: ["p5MonthOrders"] }),
    ]);
  }, [queryClient]);

  /* ------------------------------ OFFLINE SYNC ------------------------------ */

  const processOfflineQueue = useCallback(async (opts?: { silent?: boolean }) => {
    const silent = !!opts?.silent;
    if (syncingRef.current) return { failed: 0, stockErrors: 0 };
    if (!navigator.onLine) return { failed: 0, stockErrors: 0 };

    const queue = readSalesQueue();

    if (!queue.length) {
      void refreshPendingSyncCount();
      return { failed: 0, stockErrors: 0 };
    }

    syncingRef.current = true;
    setSyncStatus("syncing");
    const toastId = silent ? null : toast.loading(`Syncing ${queue.length} offline sales...`);

    try {
      const failed: OfflineSale[] = [];

      for (const sale of queue) {
        try {
          const saleItems = ensureLineIds(sale.items || []);
          const saleTime = new Date(sale.meta.timestamp);
          const rawSaleType =
            (sale as any).saleType || (sale.meta as any)?.saleType || deriveSaleType(saleItems, "product");

          const saleType: SaleType = rawSaleType === "service" ? "service" : "product";
          const bookingId: string | null =
            (sale as any).bookingId ?? (sale.meta as any)?.bookingId ?? null;

          let orderId: string | null = null;

          const { data: existing, error: existingErr } = await supabase
  .schema("public")
  .from("orders")
  .select("id")
  .eq("receipt_id", sale.meta.receiptId)
  .maybeSingle();
          if (existingErr) throw existingErr;

          if (existing?.id) {
            orderId = existing.id;
          } else {
            const { data: authUserRes } = await supabase.auth.getUser();
            const cashierId = authUserRes?.user?.id;

            if (cashierId) {
              const { error: profileUpsertErr } = await supabase
                .schema("public")
                .from("profiles")
                .upsert({ id: cashierId })
                .select("id")
                .maybeSingle();

              if (profileUpsertErr) {
                console.error("[profiles upsert] error object:", profileUpsertErr);
              }
            }
            const orderRow: any = {
              cashier_id: String(cashierId || sale.cashierId),
              total_amount: Number(sale.total) || 0,
              payment_method: String(sale.payments?.[0]?.method || "cash"),
              status: "completed",
              created_at: new Date(saleTime).toISOString(),
              receipt_id: String(sale.meta.receiptId),
              receipt_number: String(sale.meta.receiptNumber),
            };

            // Only send optional fields if they actually exist (avoid NOT NULL / type errors)
            if (sale.customerName && String(sale.customerName).trim()) {
              orderRow.customer_name = String(sale.customerName).trim();
            }
            if (bookingId && String(bookingId).trim()) {
              orderRow.booking_id = String(bookingId).trim();
            }

            try {
              const inserted = await insertOrderWithSaleTypeFallback(orderRow, saleType);
              console.log("[orders insert] sale_type =", inserted.saleTypeUsed);
              orderId = inserted.id;
            } catch (error: any) {
              console.error("[orders insert] error object:", error);
              console.error("[orders insert] orderRow payload:", orderRow);
              throw error;
            }
          }

          const { error: delErr } = await supabase
  .schema("public")
  .from("order_items")
  .delete()
  .eq("order_id", orderId);
          if (delErr) throw delErr;

          const { error: itemsErr } = await supabase.from("order_items").insert(
            saleItems.map((i) => ({
              order_id: orderId,
              product_id: i.product.id,
              product_name: i.product.name,
              quantity: Number(i.quantity),
              price_at_sale: (i as any).customPrice ?? i.product.price,
              cost_at_sale: (i.product as any).cost_price || 0,
              service_note: (i as any).customDescription || null,
            }))
          );
          if (itemsErr) throw itemsErr;

          await decrementStockForItems(saleItems);
          await invalidateSalesQueries();
        } catch (e: any) {
          failed.push({ ...sale, lastError: errorToMessage(e) });
        }
      }

      writeQueue(failed);

      if (failed.length) {
        setSyncStatus("error");
        if (!silent) toast.error(`${failed.length} sales failed to sync`);
      } else {
        setSyncStatus("online");
        if (!silent) toast.success("All offline sales synced");
      }

      return { failed: failed.length, stockErrors: 0 };
    } finally {
      if (toastId != null) toast.dismiss(toastId);
      syncingRef.current = false;
    }
  }, [invalidateSalesQueries, refreshPendingSyncCount]);

  const runGlobalSync = useCallback(
    async (opts?: { silent?: boolean }) => {
      const silent = !!opts?.silent;
      if (globalSyncingRef.current) return;
      if (!currentUser) return;
      if (!navigator.onLine) return;

      globalSyncingRef.current = true;
      setSyncStatus("syncing");

      let anyFailed = false;

      try {
        const countsBefore = await refreshPendingSyncCount();
        const hasPendingWork = countsBefore.total > 0;

        if (hasPendingWork) {
          const sessionRes = await ensureSupabaseSession();
          if (!sessionRes.ok) {
            anyFailed = true;

            const now = Date.now();
            const showToast = !silent || now - lastCloudAuthNoticeRef.current > 5 * 60_000;
            if (showToast) {
              lastCloudAuthNoticeRef.current = now;
              toast.error(`Sync issue — check network or sign in again.`);
            }
            // DO NOT return — still attempt sync using anon role if allowed by RLS
          }
        }

        // Sales
        try {
          const salesRes = await processOfflineQueue({ silent });
          if (salesRes.stockErrors > 0) anyFailed = true;
        } catch {
          anyFailed = true;
        }

        // Inventory
        try {
          await processInventoryQueue({ silent, queryClient });
        } catch {
          anyFailed = true;
        }

        // Expenses
        try {
          await syncExpenses();
        } catch {
          anyFailed = true;
        }

        // Service bookings
        try {
          await pushUnsyncedServiceBookings();
        } catch {
          anyFailed = true;
        }
        try {
          await pullRecentServiceBookings(30);
        } catch {
          // pull failures shouldn't block everything
        }
      } finally {
        globalSyncingRef.current = false;
        const counts = await refreshPendingSyncCount();

        if (!navigator.onLine) setSyncStatus("offline");
        else if (anyFailed || counts.total > 0) setSyncStatus("error");
        else setSyncStatus("online");
      }
    },
    [currentUser, processOfflineQueue, queryClient, refreshPendingSyncCount]
  );

  /* ---------------------------- ONLINE / OFFLINE ---------------------------- */

  useEffect(() => {
    const update = async () => {
      const online = navigator.onLine;
      setSyncStatus(online ? "online" : "offline");
      if (online) await runGlobalSync({ silent: true });
    };

    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    update();

    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, [runGlobalSync]);

  useEffect(() => {
    const { data } = supabase.auth.onAuthStateChange((event, session) => {
      if (!currentUser) return;
      if (!navigator.onLine) return;
      if (!session) return;
      if (event === "SIGNED_IN" || event === "TOKEN_REFRESHED") {
        runGlobalSync({ silent: true });
      }
    });

    return () => data.subscription.unsubscribe();
  }, [currentUser, runGlobalSync]);

  useEffect(() => {
    if (!currentUser) return;
    if (!navigator.onLine) return;
    runGlobalSync({ silent: true });
  }, [currentUser, runGlobalSync]);

  useEffect(() => {
    const onQueueChanged = () => {
      void refreshPendingSyncCount();
      if (navigator.onLine) runGlobalSync({ silent: true });
    };

    window.addEventListener("binancexi:queue_changed", onQueueChanged as any);
    return () => window.removeEventListener("binancexi:queue_changed", onQueueChanged as any);
  }, [refreshPendingSyncCount, runGlobalSync]);

  // Background auto-retry (helps Capacitor where "online" events can be flaky).
  useEffect(() => {
    if (pendingSyncCount <= 0) return;
    const t = setInterval(() => {
      if (!navigator.onLine) return;
      runGlobalSync({ silent: true });
    }, 30_000);
    return () => clearInterval(t);
  }, [pendingSyncCount, runGlobalSync]);

  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState !== "visible") return;
      if (!navigator.onLine) return;
      runGlobalSync({ silent: true });
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [runGlobalSync]);

  /* ------------------------------- CART LOGIC ------------------------------- */

  const addToCart = (product: Product, desc?: string, price?: number) => {
    const productName = String((product as any)?.name || "Item");
    const availableStock = Math.max(
      0,
      Math.floor(Number((product as any)?.stock_quantity ?? (product as any)?.stock ?? 0))
    );

    if ((product as any)?.type === "good" && availableStock <= 0) {
      toast.error(`${productName} is out of stock`);
      return false;
    }

    let limitReached = false;
    setCart((prev) => {
      const custom = (product as any).type === "service" && (desc || price !== undefined);
      if (custom) {
        return [
          ...prev,
          {
            lineId: newLineId(),
            product,
            quantity: 1,
            discount: 0,
            discountType: "percentage",
            customDescription: desc,
            customPrice: price,
          } as any,
        ];
      }

      const existing = prev.find(
        (i: any) =>
          i.product.id === (product as any).id &&
          !i.customDescription &&
          i.customPrice === undefined
      );

      if (existing) {
        if ((product as any)?.type === "good" && Number((existing as any).quantity || 0) >= availableStock) {
          limitReached = true;
          return prev;
        }
        return prev.map((i: any) =>
          i.lineId === (existing as any).lineId ? { ...i, quantity: Number(i.quantity) + 1 } : i
        );
      }

      return [
        ...prev,
        {
          lineId: newLineId(),
          product,
          quantity: 1,
          discount: 0,
          discountType: "percentage",
        } as any,
      ];
    });

    if (limitReached) {
      toast.error(`Stock limit reached for ${productName} (${availableStock} available)`);
      return false;
    }
    return true;
  };

  const removeFromCart = (id: string) => setCart((prev) => prev.filter((i: any) => i.lineId !== id));

  const updateCartItemQuantity = (id: string, qty: number) => {
    if (qty <= 0) return removeFromCart(id);

    let limitedTo = 0;
    let limitedName = "";
    setCart((prev) => {
      const next: CartItem[] = [];
      for (const raw of prev as any[]) {
        if (raw.lineId !== id) {
          next.push(raw);
          continue;
        }

        const current = Math.max(0, Math.floor(Number(qty) || 0));
        if ((raw as any)?.product?.type !== "good") {
          next.push({ ...raw, quantity: current });
          continue;
        }

        const available = Math.max(
          0,
          Math.floor(Number((raw as any)?.product?.stock_quantity ?? (raw as any)?.product?.stock ?? 0))
        );
        if (current <= available && available > 0) {
          next.push({ ...raw, quantity: current });
          continue;
        }

        limitedTo = available;
        limitedName = String((raw as any)?.product?.name || "Item");
        if (available > 0) next.push({ ...raw, quantity: available });
      }
      return next;
    });

    if (limitedName) {
      toast.error(`Stock limit reached for ${limitedName} (${limitedTo} available)`);
    }
  };

  const updateCartItemCustom = (id: string, desc?: string, price?: number) => {
    if (!can("allowPriceEdit")) {
      toast.error("Not allowed to edit prices");
      return;
    }
    setCart((prev) =>
      prev.map((i: any) =>
        i.lineId === id ? { ...i, customDescription: desc, customPrice: price } : i
      )
    );
  };

  const updateCartItemDiscount = (id: string, discount: number, type: "percentage" | "fixed") => {
    if (!can("allowDiscount")) {
      toast.error("Not allowed to apply discounts");
      return;
    }
    setCart((prev) =>
      prev.map((i: any) => (i.lineId === id ? { ...i, discount, discountType: type } : i))
    );
  };

  const clearCart = () => {
    setCart([]);
    setCustomerName("");
    setActiveDiscount(null);
  };

  /* ------------------------------ HELD SALES -------------------------------- */

  const holdCurrentSale = () => {
    if (!currentUser || !cart.length) return;

    const subtotal = cart.reduce((s: number, i: any) => {
      const price = i.customPrice ?? i.product.price;
      return s + Number(price) * Number(i.quantity);
    }, 0);

    const held: any = {
      id: `held-${Date.now()}`,
      items: ensureLineIds(cart as any),
      subtotal,
      tax: 0,
      discount: 0,
      total: subtotal,
      payments: [],
      cashier: currentUser,
      cashierId: currentUser.id,
      customerName,
      timestamp: new Date(),
      status: "held",
    };

    setHeldSales((prev) => [...prev, held]);
    clearCart();
  };

  const resumeSale = (saleId: string) => {
    const sale: any = heldSales.find((s: any) => s.id === saleId);
    if (!sale) return;

    setCart(ensureLineIds(sale.items || []) as any);
    setCustomerName(sale.customerName || "");
    setHeldSales((prev) => prev.filter((s: any) => s.id !== saleId));
  };

  /* ------------------------------ DISCOUNTS -------------------------------- */

  const applyDiscountCode = (code: string) => {
    const c = String(code || "").trim().toLowerCase();
    if (!c) return false;

    toast.message("Discount codes not configured yet");
    return false;
  };

  /* ------------------------------ COMPLETE SALE ----------------------------- */

  const persistSale = async (args: {
    cashierId: string;
    customerName: string;
    total: number;
    payments: Payment[];
    items: CartItem[];
    meta: SaleMeta;
    saleType: SaleType;
    bookingId?: string | null;
  }) => {
    const saleItems = ensureLineIds(args.items || []);
    const saleData: OfflineSale = {
      cashierId: args.cashierId,
      customerName: args.customerName,
      total: args.total,
      payments: args.payments,
      items: saleItems,
      meta: args.meta,
      saleType: args.saleType,
      bookingId: args.bookingId ?? null,
      synced: false,
    };

    if (navigator.onLine) {
      const insertOnline = async () => {
        await ensureStockAvailableForItems(saleItems);

        const { data: authUserRes } = await supabase.auth.getUser();
        const cashierId = authUserRes?.user?.id;

        if (cashierId) {
          const { error: profileUpsertErr } = await supabase
            .schema("public")
            .from("profiles")
            .upsert({ id: cashierId })
            .select("id")
            .maybeSingle();

          if (profileUpsertErr) {
            console.error("[profiles upsert] error object:", profileUpsertErr);
          }
        }
        const orderRow: any = {
          cashier_id: String(cashierId || saleData.cashierId),
          total_amount: Number(saleData.total) || 0,
          payment_method: String(saleData.payments?.[0]?.method || "cash"),
          status: "completed",
          created_at: new Date(saleData.meta.timestamp).toISOString(),
          receipt_id: String(saleData.meta.receiptId),
          receipt_number: String(saleData.meta.receiptNumber),
        };

        if (saleData.customerName && String(saleData.customerName).trim()) {
          orderRow.customer_name = String(saleData.customerName).trim();
        }
        if (saleData.bookingId && String(saleData.bookingId).trim()) {
          orderRow.booking_id = String(saleData.bookingId).trim();
        }

        const normalizedSaleType: SaleType = saleData.saleType === "service" ? "service" : "product";
        let orderId = "";
        try {
          const inserted = await insertOrderWithSaleTypeFallback(orderRow, normalizedSaleType);
          orderId = inserted.id;
          console.log("[orders insert online] sale_type =", inserted.saleTypeUsed);
        } catch (orderErr: any) {
          console.error("[orders insert ONLINE] error object:", orderErr);
          console.error("[orders insert ONLINE] orderRow payload:", orderRow);
          throw orderErr;
        }

        const { error: itemsErr } = await supabase
        .schema("public")
        .from("order_items")
        .insert(
          saleItems.map((i: any) => ({
            order_id: orderId,
            product_id: i.product.id,
            product_name: i.product.name,
            quantity: Number(i.quantity),
            price_at_sale: i.customPrice ?? i.product.price,
            cost_at_sale: i.product.cost_price || 0,
            service_note: i.customDescription || null,
          }))
        );

        if (itemsErr) throw itemsErr;

        await decrementStockForItems(saleItems);

        await invalidateSalesQueries();
        return { ok: true as const };
      };

      try {
        await insertOnline();
        toast.success("Sale saved & synced");
        return;
      } catch (e: any) {
        let msg = errorToMessage(e);

        if (isInsufficientStockError(e)) {
          saveToOfflineQueue({ ...saleData, lastError: msg });
          toast.warning("Insufficient stock — sale kept pending for reconciliation");
          return;
        }

        // If we failed due to missing/expired auth, refresh session and retry once.
        try {
          const sessionRes = await ensureSupabaseSession();
          if (sessionRes.ok) {
            try {
              await insertOnline();
              toast.success("Sale saved & synced");
              return;
            } catch (e2: any) {
              msg = errorToMessage(e2);
            }
          } else {
            msg = (sessionRes as any).error || (sessionRes as any).message || msg;
          }
        } catch {
          // ignore
        }

        saveToOfflineQueue({ ...saleData, lastError: msg });
        toast.warning("Online save failed — saved offline");
        return;
      }
    }

    saveToOfflineQueue(saleData);
    toast.success("Saved offline");
  };

  const completeSale: POSContextType["completeSale"] = async (payments, total, meta) => {
    if (!currentUser || !cart.length) return;

    const saleItems = ensureLineIds(cart as any);
    const saleType: SaleType = (meta as any)?.saleType || deriveSaleType(saleItems, "product");
    const bookingId: string | null = (meta as any)?.bookingId ?? null;
    clearCart();
    await persistSale({
      cashierId: currentUser.id,
      customerName,
      total,
      payments,
      items: saleItems,
      meta,
      saleType,
      bookingId,
    });
  };

  const recordSaleByItems: POSContextType["recordSaleByItems"] = async (args) => {
    if (!currentUser) return;
    const items = ensureLineIds(args.items || []);
    if (!items.length) return;

    const saleType: SaleType = (args.meta as any)?.saleType || deriveSaleType(items, "product");
    const bookingId: string | null = (args.meta as any)?.bookingId ?? null;
    await persistSale({
      cashierId: currentUser.id,
      customerName: args.customerName ?? "",
      total: args.total,
      payments: args.payments,
      items,
      meta: args.meta,
      saleType,
      bookingId,
    });
  };

  /* --------------------------------- VALUE --------------------------------- */

  const value = useMemo<POSContextType>(
    () => ({
      currentUser,
      setCurrentUser,
      can,
      cart,
      addToCart,
      removeFromCart,
      updateCartItemQuantity,
      updateCartItemCustom,
      updateCartItemDiscount,
      clearCart,
      syncStatus,
      setSyncStatus,
      pendingSyncCount,
      heldSales,
      holdCurrentSale,
      resumeSale,
      selectedCategory,
      setSelectedCategory,
      posMode,
      setPosMode,
      customerName,
      setCustomerName,
      activeDiscount,
      setActiveDiscount,
      applyDiscountCode,
      completeSale,
      recordSaleByItems,
      getSecureTime: () => new Date(),
    }),
    [
      currentUser,
      cart,
      syncStatus,
      pendingSyncCount,
      heldSales,
      selectedCategory,
      posMode,
      customerName,
      activeDiscount,
    ]
  );

  return <POSContext.Provider value={value}>{children}</POSContext.Provider>;
};
