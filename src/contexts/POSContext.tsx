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
export type Role = "platform_admin" | "admin" | "cashier";

export type UserPermissions = {
  allowRefunds: boolean;
  allowVoid: boolean;
  allowPriceEdit: boolean;
  allowDiscount: boolean;
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
  allowReports: true,
  allowInventory: true,
  allowSettings: true,
  allowEditReceipt: true,
};

// ✅ FIX: cashier must be able to discount if you want discounts to work at the till
export const CASHIER_DEFAULT_PERMISSIONS: UserPermissions = {
  allowRefunds: false,
  allowVoid: false,
  allowPriceEdit: false,
  allowDiscount: true, // ✅ was false (this blocked discounts)
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
  addToCart: (product: Product, customDescription?: string, customPrice?: number) => void;
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

  const syncingRef = useRef(false);
  const globalSyncingRef = useRef(false);
  const lastCloudAuthNoticeRef = useRef<number>(0);

  /* --------------------------- SESSION PERSISTENCE -------------------------- */

  const setCurrentUser = (user: POSUser | null) => {
    _setCurrentUser(user);
    if (user) localStorage.setItem(USER_KEY, JSON.stringify(user));
    else localStorage.removeItem(USER_KEY);
  };

  const can = (permission: keyof UserPermissions) => {
    if (!currentUser) return false;
    if (currentUser.role === "platform_admin" || currentUser.role === "admin") return true;
    return !!currentUser.permissions?.[permission];
  };

  const getSalesQueueCount = useCallback(() => {
    try {
      const queue = safeJSONParse<OfflineSale[]>(localStorage.getItem(OFFLINE_QUEUE_KEY), []);
      return queue.length;
    } catch {
      return 0;
    }
  }, []);

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
    const savedHeld = safeJSONParse<Sale[]>(localStorage.getItem(HELD_SALES_KEY), []);
    setHeldSales(
      savedHeld.map((s: any) => ({
        ...s,
        items: ensureLineIds(s.items || []),
      }))
    );
    void refreshPendingSyncCount();
  }, []);

  useEffect(() => {
    localStorage.setItem(HELD_SALES_KEY, JSON.stringify(heldSales));
  }, [heldSales]);

  const notifyQueueChanged = () => {
    try {
      window.dispatchEvent(new Event("binancexi:queue_changed"));
    } catch {
      // ignore
    }
  };

  const saveToOfflineQueue = (sale: OfflineSale) => {
    const queue = safeJSONParse<OfflineSale[]>(localStorage.getItem(OFFLINE_QUEUE_KEY), []);
    queue.push(sale);
    localStorage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(queue));
    notifyQueueChanged();
    void refreshPendingSyncCount();
  };

  const writeQueue = (queue: OfflineSale[]) => {
    localStorage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(queue));
    notifyQueueChanged();
    void refreshPendingSyncCount();
  };

  const annotateSalesQueueError = (msg: string) => {
    const message = String(msg || "").trim();
    if (!message) return;

    const queue = safeJSONParse<OfflineSale[]>(localStorage.getItem(OFFLINE_QUEUE_KEY), []);
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

    const queue = safeJSONParse<OfflineSale[]>(localStorage.getItem(OFFLINE_QUEUE_KEY), []);

    if (!queue.length) {
      void refreshPendingSyncCount();
      return { failed: 0, stockErrors: 0 };
    }

    syncingRef.current = true;
    setSyncStatus("syncing");
    const toastId = silent ? null : toast.loading(`Syncing ${queue.length} offline sales...`);

    try {
      const failed: OfflineSale[] = [];
      let stockErrors = 0;

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

          try {
            await decrementStockForItems(saleItems);
          } catch (e) {
            stockErrors += 1;
            console.error("Stock decrement failed during offline sale sync", e);
          }
          await invalidateSalesQueries();
        } catch (e: any) {
          failed.push({ ...sale, lastError: errorToMessage(e) });
        }
      }

      writeQueue(failed);

      if (failed.length) {
        setSyncStatus("error");
        if (!silent) toast.error(`${failed.length} sales failed to sync`);
      } else if (stockErrors > 0) {
        setSyncStatus("error");
        if (!silent) toast.warning(`Synced sales, but ${stockErrors} stock updates failed`);
      } else {
        setSyncStatus("online");
        if (!silent) toast.success("All offline sales synced");
      }

      return { failed: failed.length, stockErrors };
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
  };

  const removeFromCart = (id: string) => setCart((prev) => prev.filter((i: any) => i.lineId !== id));

  const updateCartItemQuantity = (id: string, qty: number) => {
    if (qty <= 0) return removeFromCart(id);
    setCart((prev) => prev.map((i: any) => (i.lineId === id ? { ...i, quantity: qty } : i)));
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

  // ✅ IMPORTANT: this is what POSPage will call — and it WILL work now (cashier has allowDiscount=true)
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

        let stockOk = true;
        try {
          await decrementStockForItems(saleItems);
        } catch (e) {
          stockOk = false;
          console.error("Stock decrement failed after saving order/items", e);
        }

        await invalidateSalesQueries();
        return { stockOk };
      };

      try {
        const res = await insertOnline();
        if (res.stockOk) toast.success("Sale saved & synced");
        else toast.warning("Sale saved, but stock update failed");
        return;
      } catch (e: any) {
        let msg = errorToMessage(e);

        // If we failed due to missing/expired auth, refresh session and retry once.
        try {
          const sessionRes = await ensureSupabaseSession();
          if (sessionRes.ok) {
            try {
              const res = await insertOnline();
              if (res.stockOk) toast.success("Sale saved & synced");
              else toast.warning("Sale saved, but stock update failed");
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
