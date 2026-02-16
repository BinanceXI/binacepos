// File: src/pages/POSPage.tsx
import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Search,
  X,
  Plus,
  Minus,
  Trash2,
  User,
  ScanLine,
  ShoppingCart,
  Zap,
  Loader2,
  Box,
  CloudOff,
  Percent,
  BadgeDollarSign,
  CalendarPlus,
  ClipboardList,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { usePOS } from "@/contexts/POSContext";
import { supabase } from "@/lib/supabase";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Product, CartItem } from "@/types/pos";
import { cn } from "@/lib/utils";
import { PaymentPanel, type PaymentPanelRef } from "@/components/pos/PaymentPanel";
import { BarcodeScanner } from "@/components/pos/BarcodeScanner";
import { PrintableReceipt } from "@/components/pos/PrintableReceipt";
import { useSecureTime } from "@/lib/secureTime";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Camera } from "@capacitor/camera";
import { enqueueThermalJob } from "@/lib/printQueue";
import { tryPrintThermalQueue } from "@/lib/thermalPrint";
import { createPortal } from "react-dom";
import { ServiceBookingsDialog } from "@/components/services/ServiceBookingsDialog";
import { pullRecentServiceBookings, pushUnsyncedServiceBookings } from "@/lib/serviceBookings";


type FocusArea = "search" | "customer" | "products" | "cart";
type DiscountType = "percentage" | "fixed";

function isEditableTarget(el: Element | null) {
  if (!el) return false;
  const tag = (el as HTMLElement).tagName?.toLowerCase();
  const editable = (el as HTMLElement).getAttribute?.("contenteditable");
  return tag === "input" || tag === "textarea" || editable === "true";
}

function makeReceiptId() {
  // @ts-ignore
  return globalThis.crypto?.randomUUID?.() ?? `rcpt-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
function makeReceiptNumber() {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");

  const y = d.getFullYear();
  const m = pad(d.getMonth() + 1);
  const day = pad(d.getDate());
  const hh = pad(d.getHours());
  const mm = pad(d.getMinutes());
  const ss = pad(d.getSeconds());
  const rand = Math.random().toString(16).slice(2, 6).toUpperCase();

  return `BXI-${y}${m}${day}-${hh}${mm}${ss}-${rand}`;
}

/** ---- helpers ---- */
function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}
function round2(n: number) {
  return Math.round(n * 100) / 100;
}

// Settings key (so you can control later from Settings page)
const TAX_RATE_KEY = "binancexi_tax_rate"; // store as percentage e.g. "0" or "15"

export const POSPage = () => {
  const ensureCameraPermission = useCallback(async () => {
  const perm = await Camera.checkPermissions();

  if (perm.camera !== "granted") {
    const req = await Camera.requestPermissions({ permissions: ["camera"] });
    if (req.camera !== "granted") {
      toast.error("Camera permission denied. Please allow camera access in Settings.");
      return false;
    }
  }
  return true;
}, []);
  const queryClient = useQueryClient();

  // ---- PRINTING STATE ----
  const [lastOrderData, setLastOrderData] = useState<any>(null);
  const [isPrinting, setIsPrinting] = useState(false);
  const [serviceBookingsOpen, setServiceBookingsOpen] = useState(false);
  const [serviceBookingsMode, setServiceBookingsMode] = useState<"new" | "list">("new");
  const [serviceBookingsSuggested, setServiceBookingsSuggested] = useState<{
    serviceId?: string;
    customerName?: string;
    totalPrice?: number;
    clearCartAfter?: boolean;
  }>({});

  useEffect(() => {
    const sync = async () => {
      if (!navigator.onLine) return;
      try {
        await pushUnsyncedServiceBookings();
        await pullRecentServiceBookings(30);
      } catch {
        // ignore
      }
    };

    window.addEventListener("online", sync);
    sync();
    return () => window.removeEventListener("online", sync);
  }, []);

  // ✅ PRINT + QUEUE (runs AFTER receipt UI is rendered)
useEffect(() => {
  if (!lastOrderData) return;

  // show UI "Printing..."
  setIsPrinting(true);

  // 1) Always queue first (safe)
  enqueueThermalJob({
    receiptNumber: lastOrderData.receiptNumber,
    timestamp: lastOrderData.timestamp,
    cashierName: lastOrderData.cashierName,
    customerName: lastOrderData.customerName || "",
    paymentMethod: lastOrderData.paymentMethod,
    cart: lastOrderData.cart,
    subtotal: lastOrderData.subtotal,
    discount: lastOrderData.globalDiscount,
    tax: lastOrderData.tax,
    total: lastOrderData.total,
  });

  // 2) Print queue (browser mode calls window.print inside thermalPrint.ts)
  // Delay a bit so PrintableReceipt is definitely in the DOM before window.print()
 const t = setTimeout(() => {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      tryPrintThermalQueue();
      setTimeout(() => setIsPrinting(false), 700);
    });
  });
}, 50);

  return () => clearTimeout(t);
}, [lastOrderData]);


  // ---- UI STATE ----
  const [searchQuery, setSearchQuery] = useState("");
  const [viewMode] = useState<"grid" | "list">("grid");
  const [selectedProductIndex, setSelectedProductIndex] = useState(0);
  const [showShortcuts, setShowShortcuts] = useState(false);
const [showScanner, setShowScanner] = useState(false);
const [showMobileCart, setShowMobileCart] = useState(false);

  // Global discount code dialog
  const [showDiscountDialog, setShowDiscountDialog] = useState(false);
  const [discountCode, setDiscountCode] = useState("");

  // Per-item discount dialog
  const [showItemDiscountDialog, setShowItemDiscountDialog] = useState(false);
  const [discountLineId, setDiscountLineId] = useState<string | null>(null);
  const [discountMode, setDiscountMode] = useState<"amount" | "percent">("amount");
  const [discountValueRaw, setDiscountValueRaw] = useState<string>("");

  const [focusArea, setFocusArea] = useState<FocusArea>("products");

  // Tax (controlled by Settings later; default 0 NOW)
  const [taxRatePct, setTaxRatePct] = useState<number>(0);

  useEffect(() => {
    const raw = localStorage.getItem(TAX_RATE_KEY);
    const n = raw == null ? 0 : Number(raw);
    setTaxRatePct(Number.isFinite(n) ? clamp(n, 0, 100) : 0);
  }, []);

  // If you later change settings without refresh, emit:
  // window.dispatchEvent(new Event("binancexi_settings_changed"))
  useEffect(() => {
    const onSettingsChanged = () => {
      const raw = localStorage.getItem(TAX_RATE_KEY);
      const n = raw == null ? 0 : Number(raw);
      setTaxRatePct(Number.isFinite(n) ? clamp(n, 0, 100) : 0);
    };
    window.addEventListener("binancexi_settings_changed" as any, onSettingsChanged);
    return () => window.removeEventListener("binancexi_settings_changed" as any, onSettingsChanged);
  }, []);

  const searchInputRef = useRef<HTMLInputElement>(null);
  const customerInputRef = useRef<HTMLInputElement>(null);
  const paymentPanelRef = useRef<PaymentPanelRef>(null);

  const {
    cart,
    addToCart,
    removeFromCart,
    updateCartItemQuantity,
    updateCartItemDiscount,
    clearCart,
    selectedCategory,
    setSelectedCategory,
    holdCurrentSale,
    customerName,
    setCustomerName,
    activeDiscount,
    setActiveDiscount,
    posMode,
    setPosMode,
    currentUser,
    completeSale,
    recordSaleByItems,
    syncStatus,
  } = usePOS();

  const { formatDate } = useSecureTime();

  // ✅ total item count (sum quantities)
  const cartItemCount = useMemo(
    () => cart.reduce((sum, it) => sum + Number((it as any).quantity || 0), 0),
    [cart]
  );

  // ---- PRODUCTS ----
  const {
    data: productsRaw = [],
    isLoading: productsLoading,
    isError,
  } = useQuery({
    queryKey: ["products"],
    queryFn: async () => {
      // If you have is_archived in DB, hide archived so POS updates instantly after "delete"
      const { data, error } = await supabase
  .schema("public")
  .from("products")
  .select("*")
  .eq("is_archived", false)
  .order("name");

      if (error) throw error;

      return (data || []).map((p: any) => ({
        ...p,
        shortcutCode: p.shortcut_code,
        lowStockThreshold: p.low_stock_threshold || 5,
        image: p.image_url,
      })) as Product[];
    },
    staleTime: 0,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    refetchOnMount: "always",
  });

  // ✅ Make POS auto-refresh when inventory changes (delete/edit/add)
  useEffect(() => {
    const channel = supabase
      .channel("products-changes")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "products" },
        () => {
          queryClient.invalidateQueries({ queryKey: ["products"] });
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [queryClient]);

  const products = productsRaw;

  const categories = useMemo(
    () =>
      Array.from(new Set(products.map((p) => (p as any).category)))
        .filter(Boolean)
        .map((c) => ({ id: c as string, name: c as string })),
    [products]
  );

  const filteredProducts = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    const raw = searchQuery.trim();

    return products.filter((product: any) => {
      const matchesSearch =
        !query ||
        String(product.name || "").toLowerCase().includes(query) ||
        (!!product.sku && String(product.sku).toLowerCase().includes(query)) ||
        (!!product.barcode && String(product.barcode).includes(raw)) ||
        (!!product.shortcutCode && String(product.shortcutCode).toLowerCase() === query);

      const matchesCategory =
        !selectedCategory || selectedCategory === "all" || product.category === selectedCategory;

      const matchesMode = posMode === "retail" ? product.type !== "service" : product.type === "service";

      return matchesSearch && matchesCategory && matchesMode;
    });
  }, [products, searchQuery, selectedCategory, posMode]);

  useEffect(() => {
    if (filteredProducts.length === 0) {
      setSelectedProductIndex(0);
      return;
    }
    setSelectedProductIndex((i) => Math.max(0, Math.min(i, filteredProducts.length - 1)));
  }, [filteredProducts.length]);

  // ---- TOTALS ----
  const subtotal = useMemo(() => {
    return cart.reduce((sum, item: CartItem) => {
      const it: any = item as any;
      const price = it.customPrice ?? it.product.price;
      const itemTotal = Number(price) * Number(it.quantity);

      const dType = (it.discountType as DiscountType | undefined) ?? "percentage";
      const dVal = Number(it.discount || 0);

      const itemDiscount = dType === "percentage" ? itemTotal * (dVal / 100) : dVal;

      return sum + itemTotal - itemDiscount;
    }, 0);
  }, [cart]);

  const globalDiscount = useMemo(() => {
    if (!activeDiscount) return 0;
    return activeDiscount.type === "percentage"
      ? subtotal * (activeDiscount.value / 100)
      : activeDiscount.value;
  }, [activeDiscount, subtotal]);

  const discountedSubtotal = subtotal - globalDiscount;

  // ✅ Tax now controlled (default 0). If you want NO TAX now, just keep TAX_RATE_KEY = 0.
  const tax = round2(discountedSubtotal * (taxRatePct / 100));
  const total = round2(discountedSubtotal + tax);

  const setPosModeSafe = useCallback(
    (next: any) => {
      if (cart.length > 0) {
        toast.error("Clear the cart before switching modes");
        return;
      }
      setPosMode(next);
    },
    [cart.length, setPosMode]
  );

  // ---- QUICK ENTRY ----
  const handleQuickEntry = useCallback(
    (code: string) => {
      const trimmed = (code || "").trim();
      if (!trimmed) return false;

      const product: any = products.find(
        (p: any) =>
          p.barcode === trimmed ||
          p.sku === trimmed ||
          (!!p.shortcutCode && String(p.shortcutCode).toLowerCase() === trimmed.toLowerCase())
      );

      if (!product) return false;

      if (product.type === "good" && Number(product.stock_quantity ?? 0) <= 0) {
        toast.error("Out of stock");
        return true;
      }

      addToCart(product);
      setSearchQuery("");
      toast.success(`${product.name} added`);
      return true;
    },
    [addToCart, products]
  );

  // ---- PAYMENT COMPLETE ----
  const handlePaymentComplete = async (method: string) => {
  if (cart.length === 0) return;

  const cartSnapshot = [...cart];

  const receiptId = makeReceiptId();
  const receiptNumber = makeReceiptNumber();
  const timestamp = new Date().toISOString();

  await completeSale([{ method, amount: total }], total, {
    receiptId,
    receiptNumber,
    timestamp,
    saleType: posMode === "service" ? "service" : "product",
  });
  queryClient.invalidateQueries({ queryKey: ["receipts"] });

  // ✅ set receipt data first (so print works)
  setLastOrderData({
    cart: cartSnapshot,
    subtotal,
    globalDiscount,
    tax,
    total,
    cashierName: currentUser?.name || currentUser?.full_name || "Staff",
    customerName: customerName?.trim() || "",
    receiptId,
    receiptNumber,
    paymentMethod: method,
    timestamp,
    activeDiscount: activeDiscount ?? null,
    taxRatePct,
  });

  // ✅ reset POS after sale
  clearCart();
  setCustomerName("");
  setActiveDiscount(null as any);
  toast.success("Sale completed");
};

  const serviceProducts = useMemo(
    () => (products || []).filter((p: any) => p?.type === "service") as Product[],
    [products]
  );

  const printAdhocSale = useCallback(
    (args: {
      cart: CartItem[];
      total: number;
      paymentMethod: string;
      customerName: string;
      receiptId: string;
      receiptNumber: string;
      timestamp: string;
    }) => {
      setLastOrderData({
        cart: args.cart,
        subtotal: args.total,
        globalDiscount: 0,
        tax: 0,
        total: args.total,
        cashierName: currentUser?.name || currentUser?.full_name || "Staff",
        customerName: args.customerName?.trim() || "",
        receiptId: args.receiptId,
        receiptNumber: args.receiptNumber,
        paymentMethod: args.paymentMethod,
        timestamp: args.timestamp,
        activeDiscount: null,
        taxRatePct: 0,
      });
    },
    [currentUser]
  );

  const openNewServiceBooking = useCallback(() => {
    if (posMode !== "service") {
      toast.error("Switch to Service mode to book a service");
      return;
    }

    if (cart.length > 0) {
      if (cart.length !== 1) {
        toast.error("Booking requires a single service in the cart");
        return;
      }
      const it: any = cart[0] as any;
      if (it?.product?.type !== "service") {
        toast.error("Booking requires a service item");
        return;
      }
      setServiceBookingsSuggested({
        serviceId: it.product.id,
        customerName: customerName || "",
        totalPrice: total,
        clearCartAfter: true,
      });
    } else {
      setServiceBookingsSuggested({
        customerName: customerName || "",
      });
    }

    setServiceBookingsMode("new");
    setServiceBookingsOpen(true);
  }, [cart, customerName, posMode, total]);

  const openServiceBookingsList = useCallback(() => {
    setServiceBookingsSuggested({});
    setServiceBookingsMode("list");
    setServiceBookingsOpen(true);
  }, []);


  // ---- GLOBAL DISCOUNT CODE ----
  const handleApplyDiscount = useCallback(() => {
    if (discountCode.trim().toUpperCase() === "VIP10") {
      setActiveDiscount({ id: "VIP10", name: "VIP", type: "percentage", value: 10, active: true } as any);
      setShowDiscountDialog(false);
      setDiscountCode("");
      toast.success("VIP Discount Applied");
      return;
    }
    toast.error("Invalid Discount Code");
  }, [discountCode, setActiveDiscount]);

  // ---- ITEM DISCOUNT ----
  const openItemDiscount = useCallback(
    (lineId: string) => {
      const item: any = cart.find((x: any) => x.lineId === lineId);
      if (!item) return;

      setDiscountLineId(lineId);

      const dType = (item.discountType as DiscountType | undefined) ?? "percentage";
      const dVal = Number(item.discount || 0);

      if (dType === "percentage") {
        setDiscountMode("percent");
        setDiscountValueRaw(String(dVal || 0));
      } else {
        setDiscountMode("amount");
        setDiscountValueRaw(String(dVal || 0));
      }

      setShowItemDiscountDialog(true);
    },
    [cart]
  );

  const applyItemDiscount = useCallback(() => {
    if (!discountLineId) return;

    const raw = Number(String(discountValueRaw || "").trim());
    if (!Number.isFinite(raw) || raw < 0) {
      toast.error("Invalid discount");
      return;
    }

    const item: any = cart.find((x: any) => x.lineId === discountLineId);
    if (!item) return;

    const unitPrice = item.customPrice ?? item.product.price;
    const lineTotal = Number(unitPrice) * Number(item.quantity);

    const type: DiscountType = discountMode === "percent" ? "percentage" : "fixed";
    let value = raw;

    if (type === "fixed") value = round2(clamp(value, 0, lineTotal));
    else value = round2(clamp(value, 0, 100));

    // ✅ THIS is what makes the button actually work
    updateCartItemDiscount(discountLineId, value, type);

    setShowItemDiscountDialog(false);
    toast.success("Discount applied");
  }, [discountLineId, discountMode, discountValueRaw, cart, updateCartItemDiscount]);

  const clearItemDiscount = useCallback(() => {
    if (!discountLineId) return;
    updateCartItemDiscount(discountLineId, 0, "fixed");
    setShowItemDiscountDialog(false);
    toast.success("Discount removed");
  }, [discountLineId, updateCartItemDiscount]);

  // ---- KEYBOARD ----
  const moveSelection = useCallback(
    (delta: number) => {
      if (filteredProducts.length === 0) return;
      setSelectedProductIndex((i) => Math.max(0, Math.min(i + delta, filteredProducts.length - 1)));
    },
    [filteredProducts.length]
  );

  const addSelectedProduct = useCallback(() => {
    if (filteredProducts.length === 0) return;
    const p: any = filteredProducts[selectedProductIndex];
    if (!p) return;

    if (p.type === "good" && Number(p.stock_quantity ?? 0) <= 0) {
      toast.error("Out of stock");
      return;
    }

    addToCart(p);
    toast.success(`${p.name} added`);
  }, [filteredProducts, selectedProductIndex, addToCart]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      const targetEditable = isEditableTarget(document.activeElement);

      if (e.key === "Escape") {
        if (showScanner) {
          e.preventDefault();
          setShowScanner(false);
          return;
        }
        if (showDiscountDialog) {
          e.preventDefault();
          setShowDiscountDialog(false);
          return;
        }
        if (showItemDiscountDialog) {
          e.preventDefault();
          setShowItemDiscountDialog(false);
          return;
        }
      }

      if (e.key === "F1") {
        e.preventDefault();
        setShowShortcuts((p) => !p);
        return;
      }
      if (e.key === "F2") {
        e.preventDefault();
        searchInputRef.current?.focus();
        setFocusArea("search");
        return;
      }
      if (e.key === "F8") {
        e.preventDefault();
        customerInputRef.current?.focus();
        setFocusArea("customer");
        return;
      }
      if (e.key === "F9") {
        e.preventDefault();
        setShowScanner(true);
        return;
      }
      if (e.key === "F10") {
        e.preventDefault();
        setPosModeSafe(posMode === "retail" ? "service" : "retail");
        return;
      }
      if (e.key === "F3") {
        e.preventDefault();
        if (cart.length > 0) holdCurrentSale();
        return;
      }
      if (e.key === "F12") {
        e.preventDefault();
        if (cart.length > 0) paymentPanelRef.current?.openPayment?.();
        return;
      }
      if (e.key === "F4") {
        e.preventDefault();
        paymentPanelRef.current?.selectPaymentMethod?.(0);
        return;
      }

      // F6 = Discount code dialog
      if (e.key === "F6") {
        e.preventDefault();
        setShowDiscountDialog(true);
        return;
      }

      if (targetEditable) {
        if (document.activeElement === searchInputRef.current && e.key === "Enter") {
          if (!searchQuery.trim()) return;
          e.preventDefault();
          const found = handleQuickEntry(searchQuery);
          if (!found && filteredProducts.length > 0) {
            const first: any = filteredProducts[0];
            if (first.type === "good" && Number(first.stock_quantity ?? 0) <= 0) return;
            addToCart(first);
            setSearchQuery("");
          }
        }
        return;
      }

      if (e.key === "ArrowDown") {
        e.preventDefault();
        setFocusArea("products");
        moveSelection(1);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setFocusArea("products");
        moveSelection(-1);
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        addSelectedProduct();
        return;
      }

      if (e.key === "Delete") {
        if (cart.length > 0) {
          e.preventDefault();
          clearCart();
          toast.info("Cart cleared");
        }
      }
    },
    [
      showScanner,
      showDiscountDialog,
      showItemDiscountDialog,
      searchQuery,
      cart.length,
      posMode,
      setPosMode,
      holdCurrentSale,
      handleQuickEntry,
      filteredProducts,
      addToCart,
      moveSelection,
      addSelectedProduct,
      clearCart,
    ]
  );

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown, { passive: false });
    return () => window.removeEventListener("keydown", handleKeyDown as any);
  }, [handleKeyDown]);

  // ---- CART HANDLERS (by lineId) ----
  const decQty = useCallback(
    (lineId: string, currentQty: number) => updateCartItemQuantity(lineId, currentQty - 1),
    [updateCartItemQuantity]
  );
  const incQty = useCallback(
    (lineId: string, currentQty: number) => updateCartItemQuantity(lineId, currentQty + 1),
    [updateCartItemQuantity]
  );
  const removeLine = useCallback((lineId: string) => removeFromCart(lineId), [removeFromCart]);

  return (
  <div className="flex min-h-[100dvh] flex-col lg:flex-row bg-background pt-[env(safe-area-inset-top)]">
      <AnimatePresence>
        {showShortcuts && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed left-4 top-20 z-50 bg-popover border border-border rounded-xl p-4 shadow-xl w-96 text-popover-foreground"
          >
            <div className="flex justify-between mb-2 font-bold">
              <h3>Shortcuts</h3>
              <X className="cursor-pointer" onClick={() => setShowShortcuts(false)} />
            </div>

            <div className="text-xs grid grid-cols-2 gap-2">
              <div>
                <kbd className="bg-muted px-1 rounded">F2</kbd> Search
              </div>
              <div>
                <kbd className="bg-muted px-1 rounded">F8</kbd> Customer
              </div>
              <div>
                <kbd className="bg-muted px-1 rounded">F9</kbd> Scan
              </div>
              <div>
                <kbd className="bg-muted px-1 rounded">F10</kbd> Retail/Service
              </div>
              <div>
                <kbd className="bg-muted px-1 rounded">F12</kbd> Pay
              </div>
              <div>
                <kbd className="bg-muted px-1 rounded">F3</kbd> Hold Sale
              </div>
              <div>
                <kbd className="bg-muted px-1 rounded">F6</kbd> Discount Code
              </div>
              <div>
                <kbd className="bg-muted px-1 rounded">↑ ↓</kbd> Navigate products
              </div>
              <div>
                <kbd className="bg-muted px-1 rounded">Enter</kbd> Add selected
              </div>
              <div>
                <kbd className="bg-muted px-1 rounded">Del</kbd> Clear cart
              </div>
              <div>
                <kbd className="bg-muted px-1 rounded">Esc</kbd> Close panels
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* LEFT COLUMN */}
<div className="flex-1 flex flex-col min-w-0 bg-slate-50/50 dark:bg-slate-950/50">
        <div className="p-3 bg-card border-b border-border flex justify-between items-center gap-3 shadow-sm z-10">
          <div className="text-xs font-mono bg-muted px-2 py-1 rounded flex items-center gap-2">
            <span
              className={cn(
                "w-2 h-2 rounded-full",
                syncStatus === "online" && "bg-green-500 animate-pulse",
                syncStatus === "offline" && "bg-amber-500",
                syncStatus === "syncing" && "bg-blue-500 animate-pulse",
                syncStatus === "error" && "bg-red-500"
              )}
            />
            {formatDate("datetime")}
            {syncStatus === "offline" && (
              <span className="ml-2 inline-flex items-center gap-1 text-amber-500">
                <CloudOff className="w-3 h-3" /> Offline
              </span>
            )}
          </div>

          <div className="flex bg-muted p-1 rounded-lg">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setPosModeSafe("retail")}
              className={cn("h-7 text-xs rounded-md", posMode === "retail" && "bg-background shadow-sm text-foreground")}
            >
              <Box className="w-3 h-3 mr-1" /> Retail
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setPosModeSafe("service")}
              className={cn("h-7 text-xs rounded-md", posMode === "service" && "bg-background shadow-sm text-foreground")}
            >
              <Zap className="w-3 h-3 mr-1" /> Service
            </Button>
          </div>

          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              className="h-8 text-xs gap-1"
              onClick={() => setShowDiscountDialog(true)}
              title="Discount code"
            >
              <Percent className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Discount</span>
            </Button>

            <Button
  size="icon"
  variant="outline"
  className="h-8 w-8"
  onClick={async () => {
    const ok = await ensureCameraPermission();
    if (ok) setShowScanner(true);
  }}
>
              <ScanLine className="w-4 h-4" />
            </Button>
          </div>
        </div>

        <div className="p-3 space-y-3">
          <div className="relative group">
            <Search className="absolute left-3 top-2.5 w-4 h-4 text-muted-foreground group-focus-within:text-primary transition-colors" />
            <Input
              ref={searchInputRef}
              placeholder="Search Item, SKU, or Scan (F2)..."
              className="pl-9 h-10 font-mono text-sm bg-card shadow-sm"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onFocus={() => setFocusArea("search")}
            />
            <div className="absolute right-2 top-2.5 flex gap-1">
              <kbd className="hidden sm:inline-block pointer-events-none h-5 select-none items-center gap-1 rounded border bg-muted px-1.5 font-mono text-[10px] font-medium text-muted-foreground opacity-100">
                F2
              </kbd>
            </div>
          </div>

          <div className="w-full overflow-x-auto no-scrollbar">
  <div className="flex gap-2 pb-1 min-w-max touch-pan-x">
    <Button
      size="sm"
      variant={selectedCategory === null ? "default" : "secondary"}
      onClick={() => setSelectedCategory(null)}
      className="h-8 px-4 text-xs rounded-full shrink-0"
    >
      All Items
    </Button>

    {categories.map((c) => (
      <Button
        key={c.id}
        size="sm"
        variant={selectedCategory === c.id ? "default" : "outline"}
        onClick={() => setSelectedCategory(selectedCategory === c.id ? null : c.id)}
        className="h-8 px-4 text-xs rounded-full shrink-0 bg-card hover:bg-muted"
      >
        {c.name}
      </Button>
    ))}
  </div>
</div>
        </div>

        <div className="flex-1 p-3 overflow-y-auto min-h-0 max-h-[calc(100dvh-160px)] pb-28">
          {productsLoading ? (
            <div className="flex h-full items-center justify-center">
              <Loader2 className="animate-spin text-primary" />
            </div>
          ) : isError ? (
            <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
              <p className="text-sm">Failed to load products.</p>
              <p className="text-xs opacity-70">If offline, cached products will show once you fetched them at least once.</p>
            </div>
          ) : filteredProducts.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-muted-foreground opacity-50">
              <Search className="w-12 h-12 mb-2" />
              <p>No products found</p>
            </div>
          ) : (
            <div
              className={cn(
                "grid gap-3 pb-24",
                viewMode === "grid" ? "grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5" : "grid-cols-1"
              )}
              onMouseEnter={() => setFocusArea("products")}
            >
              {filteredProducts.map((product: any, i) => (
                <ProductCard
                  key={product.id}
                  product={product}
                  onAdd={(p) => {
                    addToCart(p);
                    setFocusArea("products");
                  }}
                  isSelected={i === selectedProductIndex && focusArea === "products"}
                  onHover={() => setSelectedProductIndex(i)}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* RIGHT COLUMN (Desktop sticky) */}
<div className="hidden lg:flex lg:w-[420px] lg:flex-col bg-card border-l border-border lg:h-[100dvh] lg:sticky lg:top-0 shadow-2xl z-20">
        <div className="p-4 border-b space-y-3 bg-card">
          <div className="flex justify-between items-center">
            <h2 className="font-bold text-lg flex items-center gap-2">
              <ShoppingCart className="w-5 h-5 text-primary" />
              Current Sale
              <span className="bg-primary/10 text-primary text-xs rounded-full px-2 py-0.5">{cartItemCount}</span>
            </h2>
            {cart.length > 0 && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  clearCart();
                  toast.info("Cart cleared");
                }}
                className="text-destructive h-8 text-xs hover:bg-destructive/10"
              >
                <Trash2 className="w-3 h-3 mr-1" /> Clear
              </Button>
            )}
          </div>

          <div className="relative">
            <User className="absolute left-3 top-2.5 w-4 h-4 text-muted-foreground" />
            <Input
              ref={customerInputRef}
              placeholder="Customer Name (Optional) [F8]"
              className="pl-9 h-9 text-sm bg-muted/50 border-transparent focus:bg-background focus:border-input transition-all"
              value={customerName}
              onChange={(e) => setCustomerName(e.target.value)}
              onFocus={() => setFocusArea("customer")}
            />
          </div>

          {activeDiscount && (
            <div className="flex items-center justify-between text-xs bg-primary/10 border border-primary/20 rounded-lg px-3 py-2">
              <div className="font-medium text-primary">
                Global Discount: {activeDiscount.name}{" "}
                {activeDiscount.type === "percentage" ? `${activeDiscount.value}%` : `$${activeDiscount.value}`}
              </div>
              <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setActiveDiscount(null as any)}>
                Remove
              </Button>
            </div>
          )}

          {taxRatePct > 0 && (
            <div className="text-[11px] text-muted-foreground">
              Tax is enabled: {taxRatePct}% (you can set it to 0 in Settings later)
            </div>
          )}
        </div>

        <div className="flex-1 overflow-y-auto p-3 space-y-2 bg-muted/10" onMouseEnter={() => setFocusArea("cart")}>
          <AnimatePresence mode="popLayout">
            {cart.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full text-muted-foreground opacity-40">
                <ShoppingCart className="w-12 h-12 mb-2" />
                <p className="text-sm">Cart is empty</p>
                <p className="text-xs">Scan or click items to add</p>
              </div>
            ) : (
              cart.map((item: any, idx) => (
                <CartItemRow
                  key={`${item.lineId ?? item.product.id}-${idx}`}
                  item={item}
                  onDec={() => decQty(item.lineId, item.quantity)}
                  onInc={() => incQty(item.lineId, item.quantity)}
                  onRemove={() => removeLine(item.lineId)}
                  onDiscount={() => openItemDiscount(item.lineId)}
                />
              ))
            )}
          </AnimatePresence>
        </div>

        {posMode === "service" && (
          <div className="px-3 pb-3">
            <div className="grid grid-cols-2 gap-2">
              <Button type="button" variant="outline" className="gap-2" onClick={openNewServiceBooking}>
                <CalendarPlus className="w-4 h-4" /> Book Service
              </Button>
              <Button type="button" variant="secondary" className="gap-2" onClick={openServiceBookingsList}>
                <ClipboardList className="w-4 h-4" /> Bookings
              </Button>
            </div>
          </div>
        )}

        <PaymentPanel ref={paymentPanelRef} subtotal={subtotal} discount={globalDiscount} tax={tax} total={total} onComplete={handlePaymentComplete} />
      </div>

      <BarcodeScanner
        isOpen={showScanner}
        onClose={() => setShowScanner(false)}
        onScan={(code) => {
          const ok = handleQuickEntry(code);
          if (!ok) toast.error("Item not found");
          setShowScanner(false);
        }}
      />
      {/* MOBILE FLOATING CART BUTTON (PORTAL FIX) */}
{typeof document !== "undefined" &&
  createPortal(
    <div
      className="lg:hidden"
      style={{
        position: "fixed",
        right: "16px",
        bottom: "calc(16px + env(safe-area-inset-bottom))",
        zIndex: 99999,
        pointerEvents: "auto",
      }}
    >
      <Button
        onClick={() => setShowMobileCart(true)}
        className="rounded-full shadow-xl h-12 px-4"
      >
        <ShoppingCart className="w-4 h-4 mr-2" />
        Cart ({cartItemCount})
      </Button>
    </div>,
    document.body
  )}

{/* MOBILE CART DIALOG */}
<Dialog open={showMobileCart} onOpenChange={setShowMobileCart}>
  <DialogContent className="p-0 max-w-[95vw] w-full">
    <div className="flex flex-col bg-card h-[85dvh]">

      {/* HEADER */}
      <div className="p-4 border-b space-y-3 bg-card">
        <div className="flex justify-between items-center">
          <h2 className="font-bold text-lg flex items-center gap-2">
            <ShoppingCart className="w-5 h-5 text-primary" />
            Current Sale
            <span className="bg-primary/10 text-primary text-xs rounded-full px-2 py-0.5">
              {cartItemCount}
            </span>
          </h2>

          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowMobileCart(false)}
          >
            Close
          </Button>
        </div>

        <div className="relative">
          <User className="absolute left-3 top-2.5 w-4 h-4 text-muted-foreground" />
          <Input
            placeholder="Customer Name"
            className="pl-9 h-9 text-sm"
            value={customerName}
            onChange={(e) => setCustomerName(e.target.value)}
          />
        </div>
      </div>

      {/* CART ITEMS */}
      <div className="flex-1 overflow-y-auto p-3 space-y-2 bg-muted/10">
        <AnimatePresence mode="popLayout">
          {cart.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-muted-foreground opacity-40">
              <ShoppingCart className="w-12 h-12 mb-2" />
              <p className="text-sm">Cart is empty</p>
            </div>
          ) : (
            cart.map((item: any, idx) => (
              <CartItemRow
                key={`${item.lineId}-${idx}`}
                item={item}
                onDec={() => decQty(item.lineId, item.quantity)}
                onInc={() => incQty(item.lineId, item.quantity)}
                onRemove={() => removeLine(item.lineId)}
                onDiscount={() => openItemDiscount(item.lineId)}
              />
            ))
          )}
        </AnimatePresence>
      </div>

      {/* PAYMENT */}
      <div className="border-t">
        {posMode === "service" && (
          <div className="p-3 border-b border-border bg-card">
            <div className="grid grid-cols-2 gap-2">
              <Button type="button" variant="outline" className="gap-2" onClick={openNewServiceBooking}>
                <CalendarPlus className="w-4 h-4" /> Book Service
              </Button>
              <Button type="button" variant="secondary" className="gap-2" onClick={openServiceBookingsList}>
                <ClipboardList className="w-4 h-4" /> Bookings
              </Button>
            </div>
          </div>
        )}
        <PaymentPanel
          ref={paymentPanelRef}
          subtotal={subtotal}
          discount={globalDiscount}
          tax={tax}
          total={total}
          onComplete={async (method) => {
            await handlePaymentComplete(method);
            setShowMobileCart(false);
          }}
        />
      </div>

    </div>
  </DialogContent>
      </Dialog>


      <ServiceBookingsDialog
        open={serviceBookingsOpen}
        onOpenChange={setServiceBookingsOpen}
        mode={serviceBookingsMode}
        services={serviceProducts}
        suggested={serviceBookingsSuggested}
        onCreateSale={async ({ items, payments, total: saleTotal, meta, customerName: saleCustomerName }) => {
          await recordSaleByItems({
            items,
            payments: payments as any,
            total: saleTotal,
            meta: meta as any,
            customerName: saleCustomerName,
          });
          queryClient.invalidateQueries({ queryKey: ["receipts"] });
        }}
        onPrintSale={printAdhocSale}
        onAfterCreateBooking={() => {
          if (serviceBookingsSuggested.clearCartAfter) {
            clearCart();
            toast.message("Booking saved — cart cleared");
          }
        }}
      />

      {/* GLOBAL DISCOUNT CODE DIALOG */}
      <Dialog open={showDiscountDialog} onOpenChange={setShowDiscountDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Enter Discount Code</DialogTitle>
          </DialogHeader>
          <Input value={discountCode} onChange={(e) => setDiscountCode(e.target.value)} placeholder="Code..." autoFocus />
          <Button onClick={handleApplyDiscount} className="w-full mt-2">
            Apply
          </Button>
        </DialogContent>
      </Dialog>

      {/* ITEM DISCOUNT DIALOG */}
      <Dialog open={showItemDiscountDialog} onOpenChange={setShowItemDiscountDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Item Discount</DialogTitle>
          </DialogHeader>

          <div className="flex gap-2">
            <Button
              type="button"
              variant={discountMode === "amount" ? "default" : "outline"}
              className="flex-1"
              onClick={() => setDiscountMode("amount")}
            >
              <BadgeDollarSign className="w-4 h-4 mr-2" /> Amount ($)
            </Button>
            <Button
              type="button"
              variant={discountMode === "percent" ? "default" : "outline"}
              className="flex-1"
              onClick={() => setDiscountMode("percent")}
            >
              <Percent className="w-4 h-4 mr-2" /> Percent (%)
            </Button>
          </div>

          <Input
            value={discountValueRaw}
            onChange={(e) => setDiscountValueRaw(e.target.value)}
            placeholder={discountMode === "amount" ? "e.g. 1 (means $1 off)" : "e.g. 10 (means 10%)"}
            inputMode="decimal"
            autoFocus
          />

          <div className="flex gap-2 mt-2">
            <Button onClick={applyItemDiscount} className="flex-1">
              Apply
            </Button>
            <Button onClick={clearItemDiscount} variant="outline" className="flex-1">
              Remove
            </Button>
          </div>

          <p className="text-xs text-muted-foreground mt-2">
            Tip: Enter <b>$1</b> and the receipt can show the implied % automatically.
          </p>
        </DialogContent>
      </Dialog>

      {/* ✅ PRINT AREA (must be ON-SCREEN for print layout, but hidden in normal view) */}
<div id="receipt-print-area" className="hidden print:block">
  {lastOrderData && (
    <PrintableReceipt
      cart={lastOrderData.cart}
      total={lastOrderData.total}
      cashierName={lastOrderData.cashierName}
      customerName={lastOrderData.customerName}
      receiptId={lastOrderData.receiptId}
      receiptNumber={lastOrderData.receiptNumber}
      paymentMethod={lastOrderData.paymentMethod}
      subtotal={lastOrderData.subtotal}
      discount={lastOrderData.globalDiscount}
      tax={lastOrderData.tax}
      activeDiscount={lastOrderData.activeDiscount}
      taxRatePct={lastOrderData.taxRatePct}
    />
  )}
</div>

      {isPrinting && (
        <div className="fixed bottom-20 right-4 z-[60] lg:hidden">
          Printing…
        </div>
      )}
    </div>
  );
};

// ---- SUB COMPONENTS ----

const ProductCard = ({
  product,
  onAdd,
  isSelected,
  onHover,
}: {
  product: Product;
  onAdd: (p: Product) => void;
  isSelected: boolean;
  onHover: () => void;
}) => {
  const p: any = product as any;
  const isOutOfStock = p.type === "good" && Number(p.stock_quantity ?? 0) <= 0;

  return (
    <button
      type="button"
      disabled={isOutOfStock}
      onMouseEnter={onHover}
      onClick={() => onAdd(product)}
      className={cn(
        "flex flex-col p-3 rounded-xl border text-left transition-all relative overflow-hidden bg-card hover:shadow-md hover:border-primary/50 group active:scale-[0.98] duration-150",
        isSelected && "ring-2 ring-primary border-primary",
        isOutOfStock && "opacity-50 grayscale cursor-not-allowed bg-muted"
      )}
    >
      {p.type === "good" && !isOutOfStock && Number(p.stock_quantity ?? 0) <= Number(p.lowStockThreshold || 5) && (
        <span className="absolute top-2 right-2 bg-amber-500/10 text-amber-500 text-[10px] font-bold px-1.5 py-0.5 rounded-full">
          Low Stock
        </span>
      )}

      <div className="w-full aspect-[4/3] rounded-lg bg-muted mb-3 overflow-hidden flex items-center justify-center">
        {p.image ? (
          <img src={p.image} alt={p.name} className="w-full h-full object-cover" />
        ) : (
          <div className="w-8 h-8 rounded-lg bg-primary/10 text-primary flex items-center justify-center group-hover:scale-110 transition-transform">
            <span className="font-bold text-sm">{String(p.name || "?").charAt(0)}</span>
          </div>
        )}
      </div>

      <div className="font-semibold text-sm truncate w-full leading-tight">{p.name}</div>
      <div className="text-[10px] text-muted-foreground mb-3">{p.category || "General"}</div>

      <div className="mt-auto flex justify-between items-end w-full">
        <span className="font-bold text-primary text-base">${Number(p.price ?? 0)}</span>

        {p.type === "good" && (
          <span className="text-[10px] text-muted-foreground bg-muted px-1.5 rounded">
            Stock: {Number(p.stock_quantity ?? 0)}
          </span>
        )}
      </div>
    </button>
  );
};

const CartItemRow = ({
  item,
  onDec,
  onInc,
  onRemove,
  onDiscount,
}: {
  item: CartItem;
  onDec: () => void;
  onInc: () => void;
  onRemove: () => void;
  onDiscount: () => void;
}) => {
  const it: any = item as any;
  const unitPrice = it.customPrice ?? it.product.price;

  const dType = (it.discountType as DiscountType | undefined) ?? "percentage";
  const dVal = Number(it.discount || 0);

  const lineTotal = Number(unitPrice) * Number(it.quantity);
  const impliedPercent = dType === "fixed" && lineTotal > 0 ? round2((dVal / lineTotal) * 100) : null;

  return (
    <motion.div
      initial={{ opacity: 0, x: 18 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -18 }}
      className="bg-card border border-border p-2.5 rounded-lg flex justify-between items-center shadow-sm"
    >
      <div className="overflow-hidden flex-1 mr-2">
        <div className="font-medium text-sm truncate flex items-center gap-2">
          {it.product.name}
          {dVal > 0 && (
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-primary/10 text-primary border border-primary/20">
              {dType === "percentage" ? `${dVal}% off` : `$${dVal} off`}
              {impliedPercent !== null && ` (~${impliedPercent}%)`}
            </span>
          )}
        </div>

        <div className="text-xs text-muted-foreground mt-0.5 flex items-center gap-1">
          <span className="font-mono text-primary">${Number(unitPrice ?? 0)}</span>
          <span>x</span>
          <span>{Number(it.quantity ?? 0)}</span>
        </div>

        <button
          type="button"
          onClick={onDiscount}
          className="mt-1 text-[11px] text-primary hover:underline inline-flex items-center gap-1"
        >
          <Percent className="w-3 h-3" /> Discount
        </button>
      </div>

      <div className="flex items-center gap-1 bg-muted/50 rounded-lg p-0.5">
        <Button type="button" size="icon" variant="ghost" className="h-7 w-7 hover:bg-background shadow-sm" onClick={onDec}>
          <Minus className="w-3 h-3" />
        </Button>

        <span className="text-xs font-bold w-6 text-center font-mono">{Number(it.quantity ?? 0)}</span>

        <Button type="button" size="icon" variant="ghost" className="h-7 w-7 hover:bg-background shadow-sm" onClick={onInc}>
          <Plus className="w-3 h-3" />
        </Button>
      </div>

      <Button
        type="button"
        size="icon"
        variant="ghost"
        className="h-7 w-7 text-muted-foreground hover:text-destructive hover:bg-destructive/10 ml-1"
        onClick={onRemove}
      >
        <Trash2 className="w-3 h-3" />
      </Button>
    </motion.div>
  );
};
