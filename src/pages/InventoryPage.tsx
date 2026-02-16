// File: src/pages/InventoryPage.tsx
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { motion } from "framer-motion";
import {
  Search,
  Plus,
  MoreVertical,
  AlertTriangle,
  ArrowUpDown,
  Edit,
  Trash2,
  Package,
  Loader2,
  DollarSign,
  Zap,
  ScanLine,
  X,
  Image as ImageIcon,
  UploadCloud,
  WifiOff,
  CloudUpload,
  Archive,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { usePOS } from "@/contexts/POSContext";
import { cn } from "@/lib/utils";
import { Product } from "@/types/pos";
import { BarcodeScanner } from "@/components/pos/BarcodeScanner";
import {
  enqueueInventoryMutation,
  getInventoryQueueCount,
  processInventoryQueue,
  type ProductUpsertPayload,
} from "@/lib/inventorySync";

function isEditableTarget(el: Element | null) {
  if (!el) return false;
  const tag = (el as HTMLElement).tagName?.toLowerCase();
  const editable = (el as HTMLElement).getAttribute?.("contenteditable");
  return tag === "input" || tag === "textarea" || editable === "true";
}

function uuid() {
  return (crypto as any)?.randomUUID?.() ?? `uuid-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export const InventoryPage = () => {
  const { currentUser, syncStatus } = usePOS();
  const isAdmin = currentUser?.role === "admin";

  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const [searchQuery, setSearchQuery] = useState("");
  const [showOutOfStockOnly, setShowOutOfStockOnly] = useState(false);
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [showScanner, setShowScanner] = useState(false);
  const [isUploading, setIsUploading] = useState(false);

  const [showProductDialog, setShowProductDialog] = useState(false);
  const [editingProduct, setEditingProduct] = useState<Product | null>(null);

  // Category UX: select existing OR create new
  const [categoryMode, setCategoryMode] = useState<"select" | "new">("select");
  const [newCategoryName, setNewCategoryName] = useState("");

  // Optional: show/hide archived (admin only)
  const [showArchived, setShowArchived] = useState(false);

  const [newItem, setNewItem] = useState({
    id: "",
    name: "",
    price: "",
    cost: "",
    stock: "",
    type: "good",
    category: "General",
    sku: "",
    shortcut: "",
    image: "",
  });

  // ------- Fetch products (React Query cache provides offline viewing) -------
  const { data: products = [], isLoading, isError } = useQuery({
    queryKey: ["products"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("products")
        .select("*")
        .order("name");

      if (error) throw error;

      return (data || []).map((item: any) => ({
        ...item,
        shortcutCode: item.shortcut_code,
        lowStockThreshold: item.low_stock_threshold ?? 5,
        price: Number(item.price) || 0,
        cost_price: Number(item.cost_price) || 0,
        stock_quantity: Number(item.stock_quantity) || 0,
        image: item.image_url,
        is_archived: !!item.is_archived,
      })) as Product[];
    },
    staleTime: 1000 * 60 * 60, // 1h
    refetchOnWindowFocus: false,
    refetchOnReconnect: true,
  });

  const visibleProducts = useMemo(() => {
    if (!isAdmin) return (products || []).filter((p: any) => !p.is_archived);
    return showArchived ? products : (products || []).filter((p: any) => !p.is_archived);
  }, [products, isAdmin, showArchived]);

  // Categories from products, plus allow "General" always
  const categories = useMemo(() => {
    const set = new Set<string>();
    set.add("General");
    (visibleProducts || []).forEach((p: any) => {
      if (p.category) set.add(String(p.category));
    });
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [visibleProducts]);

  const processQueue = useCallback(async () => {
    await processInventoryQueue({ queryClient });
  }, [queryClient]);

  // ------- Profit calcs -------
  const formPrice = parseFloat(newItem.price) || 0;
  const formCost = parseFloat(newItem.cost) || 0;
  const formStock = parseInt(newItem.stock) || 0;
  const unitProfit = formPrice - formCost;
  const margin = formPrice > 0 ? (unitProfit / formPrice) * 100 : 0;
  const totalBatchProfit = unitProfit * (newItem.type === "good" ? formStock : 0);

  // ------- Filter -------
  const filteredProducts = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();

    return (visibleProducts || []).filter((product: any) => {
      // ✅ Out of stock filter
      const matchesOutOfStock =
        !showOutOfStockOnly || (product.type === "good" && Number(product.stock_quantity || 0) === 0);

      if (!matchesOutOfStock) return false;

      // ✅ Category filter
      const matchesCategory =
        !selectedCategory || selectedCategory === "all" || product.category === selectedCategory;

      if (!matchesCategory) return false;

      // ✅ Search filter
      if (!q) return true;

      const shortcutHit = product.shortcutCode && String(product.shortcutCode).toLowerCase() === q;
      if (shortcutHit) return true;

      return (
        String(product.name || "").toLowerCase().includes(q) ||
        (!!product.sku && String(product.sku).toLowerCase().includes(q)) ||
        (!!product.shortcutCode && String(product.shortcutCode).toLowerCase().includes(q))
      );
    });
  }, [visibleProducts, searchQuery, selectedCategory, showOutOfStockOnly]);

  // ------- Helpers -------
  const resetForm = () => {
    setEditingProduct(null);
    setCategoryMode("select");
    setNewCategoryName("");
    setNewItem({
      id: "",
      name: "",
      price: "",
      cost: "",
      stock: "",
      type: "good",
      category: "General",
      sku: "",
      shortcut: "",
      image: "",
    });
  };

  const openAddDialog = () => {
    resetForm();
    setNewItem((p) => ({ ...p, id: uuid() }));
    setShowProductDialog(true);
  };

  const openEditDialog = (product: Product) => {
    setEditingProduct(product);
    setCategoryMode("select");
    setNewCategoryName("");
    setNewItem({
      id: product.id,
      name: product.name,
      price: (product.price ?? 0).toString(),
      cost: ((product as any).cost_price ?? 0).toString(),
      stock: ((product as any).stock_quantity ?? 0).toString(),
      type: (product.type as string) || "good",
      category: (product as any).category || "General",
      sku: (product as any).sku || "",
      shortcut: (product as any).shortcutCode || "",
      image: (product as any).image || "",
    });
    setShowProductDialog(true);
  };

  // ------- Image Upload (online only) -------
  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!isAdmin) return toast.error("No permission");
    if (!navigator.onLine) return toast.error("Image upload needs internet");
    if (!e.target.files || e.target.files.length === 0) return;

    setIsUploading(true);
    const file = e.target.files[0];
    if (file.size > 2 * 1024 * 1024) {
      setIsUploading(false);
      return toast.error("Image too large. Max 2MB.");
    }

    const fileExt = (file.name.split(".").pop() || "png").toLowerCase();

    const rand =
      (crypto as any)?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const fileName = `${rand}.${fileExt}`;

    try {
      // ✅ Upload via Edge Function (requires a real signed-in user session)
      const arrayBuffer = await file.arrayBuffer();
      const bytes = new Uint8Array(arrayBuffer);

      let binary = "";
      const chunkSize = 0x8000;
      for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
      }
      const base64 = btoa(binary);

      const { data, error } = await supabase.functions.invoke("upload_product_image", {
        body: {
          fileName, // ✅ unique name
          contentType: file.type || "image/png",
          base64,
        },
      });

      if (error) throw error;
      if (!(data as any)?.publicUrl) throw new Error("Upload failed (no publicUrl returned)");

      setNewItem((prev) => ({ ...prev, image: (data as any).publicUrl }));
      toast.success("Image uploaded");
    } catch (error: any) {
      console.error(error);
      toast.error(
        "Upload failed: " +
          (error?.context?.statusText || error?.message || JSON.stringify(error))
      );
    } finally {
      setIsUploading(false);
    }
  };

  // ------- Upsert (online OR offline queued) -------
  const saveProductMutation = useMutation({
    mutationFn: async () => {
      if (!isAdmin) {
        toast.error("No permission");
        return;
      }

      const finalCategory =
        categoryMode === "new" && newCategoryName.trim()
          ? newCategoryName.trim()
          : (newItem.category || "General").trim() || "General";

      const payload: ProductUpsertPayload = {
        id: newItem.id || uuid(),
        name: newItem.name.trim(),
        price: parseFloat(newItem.price) || 0,
        cost_price: parseFloat(newItem.cost) || 0,
        stock_quantity: newItem.type === "good" ? parseInt(newItem.stock) || 0 : 0,
        type: newItem.type,
        category: finalCategory,
        sku: (newItem.sku || "").trim() || null,
        shortcut_code: (newItem.shortcut || "").trim() || null,
        image_url: newItem.image || null,
        is_archived: false, // ✅ make sure edits bring it back if needed
      };

      // optimistic update
      queryClient.setQueryData<Product[]>(["products"], (prev) => {
        const list = prev ? [...prev] : [];
        const idx = list.findIndex((p: any) => p.id === payload.id);

        const merged: any = {
          ...(idx >= 0 ? list[idx] : {}),
          ...payload,
          shortcutCode: payload.shortcut_code || undefined,
          lowStockThreshold:
            (idx >= 0 ? (list[idx] as any).lowStockThreshold : 5) ?? 5,
          stock_quantity: Number(payload.stock_quantity) || 0,
          cost_price: Number(payload.cost_price) || 0,
          price: Number(payload.price) || 0,
          image: payload.image_url || "",
          is_archived: !!payload.is_archived,
        };

        if (idx >= 0) list[idx] = merged;
        else list.unshift(merged);

        return list.sort((a: any, b: any) =>
          String(a.name || "").localeCompare(String(b.name || ""))
        );
      });

      if (navigator.onLine) {
        const { error } = await supabase
          .from("products")
          .upsert(payload, { onConflict: "id" });
        if (error) throw error;
      } else {
        enqueueInventoryMutation({ kind: "upsert_product", payload, ts: Date.now() });
      }
    },
    onSuccess: () => {
      toast.success(editingProduct ? "Product updated" : "Product added");
      setShowProductDialog(false);
      resetForm();
      if (navigator.onLine) queryClient.invalidateQueries({ queryKey: ["products"] });
    },
    onError: (err: any) => {
      console.error(err);
      toast.error(err?.message || "Save failed");
      if (navigator.onLine) queryClient.invalidateQueries({ queryKey: ["products"] });
    },
  });

  // ✅ ARCHIVE (instead of DELETE) -> solves FK crash forever
  const archiveMutation = useMutation({
    mutationFn: async (id: string) => {
      if (!isAdmin) {
        toast.error("No permission");
        return;
      }

      // optimistic: mark archived in cache
      queryClient.setQueryData<Product[]>(["products"], (prev) => {
        const list = prev ? [...prev] : [];
        return list.map((p: any) =>
          p.id === id ? { ...p, is_archived: true } : p
        );
      });

      if (navigator.onLine) {
        const { error } = await supabase
          .from("products")
          .update({ is_archived: true })
          .eq("id", id);
        if (error) throw error;
      } else {
        enqueueInventoryMutation({ kind: "archive_product", id, ts: Date.now() });
      }
    },
    onSuccess: () => {
      toast.success("Product archived");
      if (navigator.onLine) queryClient.invalidateQueries({ queryKey: ["products"] });
    },
    onError: (err: any) => {
      console.error(err);
      toast.error(err?.message || "Archive failed");
      if (navigator.onLine) queryClient.invalidateQueries({ queryKey: ["products"] });
    },
  });

  const adjustStockMutation = useMutation({
    mutationFn: async ({ id, newStock }: { id: string; newStock: number }) => {
      if (!isAdmin) {
        toast.error("No permission");
        return;
      }

      // optimistic update
      queryClient.setQueryData<Product[]>(["products"], (prev) => {
        const list = prev ? [...prev] : [];
        return list.map((p: any) =>
          p.id === id ? { ...p, stock_quantity: newStock } : p
        );
      });

      if (navigator.onLine) {
        const { error } = await supabase
          .from("products")
          .update({ stock_quantity: newStock })
          .eq("id", id);
        if (error) throw error;
      } else {
        enqueueInventoryMutation({ kind: "set_stock", id, stock_quantity: newStock, ts: Date.now() });
      }
    },
    onSuccess: () => {
      toast.success("Stock updated");
      if (navigator.onLine) queryClient.invalidateQueries({ queryKey: ["products"] });
    },
    onError: (err: any) => {
      console.error(err);
      toast.error(err?.message || "Stock update failed");
      if (navigator.onLine) queryClient.invalidateQueries({ queryKey: ["products"] });
    },
  });

  // ------- Keyboard shortcuts -------
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (showScanner) {
          e.preventDefault();
          setShowScanner(false);
          return;
        }
        if (showProductDialog) {
          e.preventDefault();
          setShowProductDialog(false);
          return;
        }
      }

      if (isEditableTarget(document.activeElement)) return;

      if (e.key === "/") {
        e.preventDefault();
        searchRef.current?.focus();
        return;
      }

      if ((e.key === "n" || e.key === "N") && isAdmin) {
        e.preventDefault();
        openAddDialog();
        return;
      }
    };

    window.addEventListener("keydown", onKeyDown, { passive: false });
    return () => window.removeEventListener("keydown", onKeyDown as any);
  }, [isAdmin, showScanner, showProductDialog]);

  const handleScanSKU = (code: string) => {
    setNewItem((prev) => ({ ...prev, sku: code }));
    setShowScanner(false);
    toast.success("Scanned: " + code);
  };

  if (isLoading) {
  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <Loader2 className="animate-spin text-primary" />
    </div>
  );
}

  // ------- Stats (only count non-archived unless admin toggled showArchived) -------
  const statsBase = (products || []).filter((p: any) => !p.is_archived);

  const totalRetailValue = statsBase.reduce(
    (sum: number, p: any) => sum + (p.price || 0) * (p.stock_quantity || 0),
    0
  );

  const totalPotentialProfit = statsBase.reduce(
    (sum: number, p: any) =>
      sum + ((p.price || 0) - (p.cost_price || 0)) * (p.stock_quantity || 0),
    0
  );

  const lowStockCount = statsBase.filter((p: any) => {
    const lowThr = (p as any).lowStockThreshold || 5;
    return p.type === "good" && (p.stock_quantity || 0) <= lowThr;
  }).length;

  const outOfStockCount = statsBase.filter(
    (p: any) => p.type === "good" && (p.stock_quantity || 0) === 0
  ).length;

  const queuedCount = getInventoryQueueCount();

  return (
    <div className="p-4 md:p-6 space-y-4 md:space-y-6 pb-20">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-xl md:text-2xl font-bold">Inventory Management</h1>
          <p className="text-sm text-muted-foreground">
            {visibleProducts.length} products shown • Press{" "}
            <kbd className="bg-muted px-1 rounded">/</kbd> to search
            {isAdmin && (
              <>
                {" "}
                • Press <kbd className="bg-muted px-1 rounded">N</kbd> to add
              </>
            )}
          </p>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {syncStatus === "offline" && (
            <div className="flex items-center gap-2 text-amber-600 bg-amber-500/10 border border-amber-500/20 px-3 py-1.5 rounded-lg text-xs">
              <WifiOff className="w-4 h-4" /> Offline mode (changes will sync later)
            </div>
          )}

          {queuedCount > 0 && (
            <Button
              variant="outline"
              size="sm"
              className="gap-2"
              onClick={() => {
                if (!navigator.onLine) return toast.error("Still offline");
                processQueue();
              }}
              title="Sync queued changes"
            >
              <CloudUpload className="w-4 h-4" /> Sync ({queuedCount})
            </Button>
          )}

          {isAdmin && (
            <Button
              variant="outline"
              size="sm"
              className="gap-2"
              onClick={() => setShowArchived((v) => !v)}
              title="Show archived products"
            >
              <Archive className="w-4 h-4" />
              {showArchived ? "Hide Archived" : "Show Archived"}
            </Button>
          )}

          {isAdmin && (
            <Button
              size="sm"
              className="gap-2 bg-primary hover:bg-blue-600 shadow-lg shadow-blue-500/20"
              onClick={openAddDialog}
            >
              <Plus className="w-4 h-4" /> Add Product
            </Button>
          )}
        </div>
      </div>

      {isError && (
        <div className="bg-destructive/10 border border-destructive/30 rounded-xl p-3 text-sm text-destructive">
          Failed to refresh from server. If you’re offline, cached products will still work once loaded.
        </div>
      )}

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 md:gap-4">
        <StatBox
          label="Total Value (Retail)"
          value={`$${totalRetailValue.toLocaleString()}`}
          icon={DollarSign}
          color="text-green-500 bg-green-500/10"
        />
        <StatBox
          label="Total Potential Profit"
          value={`$${totalPotentialProfit.toLocaleString()}`}
          icon={Zap}
          color="text-blue-500 bg-blue-500/10"
        />
        <StatBox
          label="Low Stock Alert"
          value={lowStockCount}
          icon={AlertTriangle}
          color="text-amber-500 bg-amber-500/10"
        />
        <StatBox
  label="Out of Stock"
  value={outOfStockCount}
  icon={Package}
  color="text-red-500 bg-red-500/10"
  onClick={() => {
    setShowOutOfStockOnly((v) => !v);
    setSelectedCategory(null); // show across all categories
  }}
  active={showOutOfStockOnly}
/>
      </div>

      {/* Search + Categories */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4 bg-card p-3 rounded-xl border border-border">
        <div className="relative w-full sm:flex-1 sm:max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-muted-foreground" />
          <Input
            ref={searchRef}
            placeholder="Search Name, SKU or Shortcut... (press /)"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-10 font-mono"
          />
        </div>

       <div className="w-full overflow-x-auto no-scrollbar touch-pan-x">
  <div className="flex gap-2 pb-1 min-w-max">
    <Button
      variant={selectedCategory === null ? "default" : "outline"}
      size="sm"
      onClick={() => setSelectedCategory(null)}
      className="shrink-0"
    >
      All
    </Button>

    <Button
  variant={showOutOfStockOnly ? "default" : "outline"}
  size="sm"
  onClick={() => {
    setShowOutOfStockOnly((v) => !v);
    setSelectedCategory(null); // show across all categories
  }}
  className={cn(
    "shrink-0",
    showOutOfStockOnly && "bg-red-500/10 text-red-600 border-red-200 hover:bg-red-500/15"
  )}
>
  Out of Stock
  {showOutOfStockOnly && (
    <span className="ml-2 inline-flex items-center justify-center w-5 h-5 rounded-full bg-red-500/15">
      <X className="w-3 h-3" />
    </span>
  )}
</Button>

    {categories.map((cat) => (
      <Button
        key={cat}
        variant={selectedCategory === cat ? "default" : "outline"}
        size="sm"
        onClick={() => setSelectedCategory(selectedCategory === cat ? null : cat)}
        className="shrink-0"
      >
        {cat}
      </Button>
    ))}
  </div>
</div>
      </div>

      {/* Table */}
      <div className="bg-card rounded-xl border border-border shadow-sm overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[60px]">Img</TableHead>
              <TableHead>Product Name</TableHead>
              <TableHead>Codes</TableHead>
              <TableHead>Type</TableHead>
              <TableHead className="text-right">Cost</TableHead>
              <TableHead className="text-right">Price</TableHead>
              <TableHead className="text-right">Profit</TableHead>
              <TableHead className="text-right">Stock</TableHead>
              <TableHead className="w-[50px]"></TableHead>
            </TableRow>
          </TableHeader>

          <TableBody>
            {filteredProducts.map((product: any) => {
              const profit = (product.price || 0) - (product.cost_price || 0);
              const m =
                (product.price || 0) > 0 ? (profit / (product.price || 1)) * 100 : 0;

              const low =
                product.type === "good" &&
                (product.stock_quantity || 0) <= ((product as any).lowStockThreshold || 5);

              const out =
                product.type === "good" && (product.stock_quantity || 0) === 0;

              return (
                <TableRow key={product.id} className="group">
                  <TableCell>
                    <div className="w-10 h-10 rounded bg-muted flex items-center justify-center overflow-hidden">
                      {(product as any).image ? (
                        <img
                          src={(product as any).image}
                          alt={product.name}
                          className="w-full h-full object-cover"
                        />
                      ) : (
                        <ImageIcon className="w-5 h-5 text-muted-foreground opacity-50" />
                      )}
                    </div>
                  </TableCell>

                  <TableCell>
                    <div className="font-medium flex items-center gap-2">
                      {product.name}
                      {!!product.is_archived && (
                        <Badge variant="outline" className="text-[10px]">
                          Archived
                        </Badge>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground">{product.category}</div>
                  </TableCell>

                  <TableCell>
                    <div className="flex flex-col gap-1">
                      {product.sku && (
                        <Badge variant="outline" className="w-fit text-[10px] font-mono">
                          {product.sku}
                        </Badge>
                      )}
                      {(product as any).shortcutCode && (
                        <Badge className="w-fit text-[10px] font-mono bg-blue-500/10 text-blue-500 border-blue-200">
                          #{(product as any).shortcutCode}
                        </Badge>
                      )}
                    </div>
                  </TableCell>

                  <TableCell>
                    <span className="capitalize text-xs text-muted-foreground bg-muted px-2 py-1 rounded">
                      {product.type}
                    </span>
                  </TableCell>

                  <TableCell className="text-right text-muted-foreground">
                    ${(product.cost_price || 0).toFixed(2)}
                  </TableCell>

                  <TableCell className="text-right font-bold text-base">
                    ${(product.price || 0).toFixed(2)}
                  </TableCell>

                  <TableCell className="text-right">
                    <div
                      className={cn(
                        "text-xs font-medium",
                        profit >= 0 ? "text-green-600" : "text-red-500"
                      )}
                    >
                      {profit >= 0 ? "+" : ""}${profit.toFixed(2)}
                    </div>
                    <div className="text-[10px] text-muted-foreground">{m.toFixed(0)}%</div>
                  </TableCell>

                  <TableCell className="text-right">
                    {product.type === "service" ? (
                      <span className="text-xs text-muted-foreground">∞</span>
                    ) : (
                      <span
                        className={cn(
                          "font-mono font-medium px-2 py-1 rounded",
                          out
                            ? "bg-red-500/10 text-red-500"
                            : low
                            ? "bg-amber-500/10 text-amber-500"
                            : "bg-muted"
                        )}
                      >
                        {product.stock_quantity || 0}
                      </span>
                    )}
                  </TableCell>

                  <TableCell>
                    {isAdmin && (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="opacity-0 group-hover:opacity-100 transition-opacity"
                          >
                            <MoreVertical className="w-4 h-4" />
                          </Button>
                        </DropdownMenuTrigger>

                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => openEditDialog(product)}>
                            <Edit className="w-4 h-4 mr-2" /> Edit Details
                          </DropdownMenuItem>

                          {product.type === "good" && (
                            <DropdownMenuItem
                              onClick={() => {
                                const raw = prompt(
                                  "Enter new stock quantity:",
                                  String(product.stock_quantity || 0)
                                );
                                if (raw === null) return;
                                const parsed = Number(raw);
                                if (!Number.isFinite(parsed) || parsed < 0)
                                  return toast.error("Invalid stock number");
                                adjustStockMutation.mutate({
                                  id: product.id,
                                  newStock: Math.floor(parsed),
                                });
                              }}
                            >
                              <ArrowUpDown className="w-4 h-4 mr-2" /> Quick Stock Adjustment
                            </DropdownMenuItem>
                          )}

                          <DropdownMenuItem
                            className="text-destructive"
                            onClick={() => {
                              const ok = confirm(
                                "Archive this product? (Recommended)\n\nIt will disappear from inventory + POS lists, but old sales remain safe."
                              );
                              if (!ok) return;
                              archiveMutation.mutate(product.id);
                            }}
                          >
                            <Trash2 className="w-4 h-4 mr-2" /> Archive Product
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      {/* Add/Edit Dialog */}
      <Dialog open={showProductDialog} onOpenChange={setShowProductDialog}>
        <DialogContent className="max-w-xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editingProduct ? "Edit Product" : "Add New Product"}</DialogTitle>
          </DialogHeader>

          <div className="space-y-4 py-4">
            {/* Image */}
            <div className="flex justify-center">
              <div
                className="w-24 h-24 rounded-xl border-2 border-dashed border-border flex items-center justify-center cursor-pointer hover:border-primary/50 relative overflow-hidden group"
                onClick={() => {
                  if (!isAdmin) return toast.error("No permission");
                  if (!navigator.onLine) return toast.error("Offline: image upload needs internet");
                  fileInputRef.current?.click();
                }}
              >
                {newItem.image ? (
                  <img src={newItem.image} className="w-full h-full object-cover" alt="Preview" />
                ) : (
                  <div className="text-center p-2">
                    {isUploading ? (
                      <Loader2 className="w-6 h-6 animate-spin mx-auto" />
                    ) : (
                      <UploadCloud className="w-6 h-6 mx-auto text-muted-foreground" />
                    )}
                    <span className="text-[10px] text-muted-foreground mt-1 block">
                      {navigator.onLine ? "Upload Image" : "Offline (no upload)"}
                    </span>
                  </div>
                )}
                <div className="absolute inset-0 bg-black/50 hidden group-hover:flex items-center justify-center text-white text-xs font-bold">
                  {navigator.onLine ? "Change" : "Online only"}
                </div>
              </div>

              <input
                type="file"
                ref={fileInputRef}
                className="hidden"
                accept="image/*"
                onChange={handleImageUpload}
              />
            </div>

            {/* Name + Shortcut */}
            <div className="grid grid-cols-3 gap-4">
              <div className="col-span-2 space-y-2">
                <label className="text-sm font-medium">Product Name</label>
                <Input
                  placeholder="e.g. iPhone Screen Repair"
                  value={newItem.name}
                  onChange={(e) => setNewItem({ ...newItem, name: e.target.value })}
                  autoFocus
                />
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium text-blue-500">Shortcut Code</label>
                <Input
                  placeholder="e.g. S15"
                  className="font-mono bg-blue-50/50 border-blue-200"
                  value={newItem.shortcut}
                  onChange={(e) => setNewItem({ ...newItem, shortcut: e.target.value })}
                />
              </div>
            </div>

            {/* Financial */}
            <div className="p-4 bg-muted/30 rounded-lg border border-border space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <label className="text-sm font-medium">Selling Price ($)</label>
                  <Input
                    type="number"
                    placeholder="0.00"
                    value={newItem.price}
                    onChange={(e) => setNewItem({ ...newItem, price: e.target.value })}
                  />
                </div>

                <div className="space-y-2">
                  <label className="text-sm font-medium">Cost Price ($)</label>
                  <Input
                    type="number"
                    placeholder="0.00"
                    value={newItem.cost}
                    onChange={(e) => setNewItem({ ...newItem, cost: e.target.value })}
                  />
                </div>
              </div>

              <div className="space-y-2 pt-2 border-t border-border">
                <div className="flex justify-between items-center text-sm">
                  <span className="text-muted-foreground">Unit Profit:</span>
                  <div className="flex items-center gap-2">
                    <span
                      className={cn("font-bold", unitProfit >= 0 ? "text-green-600" : "text-red-500")}
                    >
                      ${unitProfit.toFixed(2)}
                    </span>
                    <Badge variant={unitProfit >= 0 ? "default" : "destructive"} className="text-xs">
                      {margin.toFixed(0)}% Margin
                    </Badge>
                  </div>
                </div>

                <div className="flex justify-between items-center text-sm bg-background p-2 rounded border border-border">
                  <span className="text-muted-foreground font-medium">Total Batch Profit:</span>
                  <span className="font-bold text-blue-600">
                    ${totalBatchProfit.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                  </span>
                </div>
              </div>
            </div>

            {/* Type + Stock */}
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <label className="text-sm font-medium">Product Type</label>
                <Select
                  value={newItem.type}
                  onValueChange={(val: any) => setNewItem({ ...newItem, type: val })}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Type" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="good">Physical Item (Stock)</SelectItem>
                    <SelectItem value="service">Service (No Stock)</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {newItem.type === "good" ? (
                <div className="space-y-2">
                  <label className="text-sm font-medium">Stock</label>
                  <Input
                    type="number"
                    value={newItem.stock}
                    onChange={(e) => setNewItem({ ...newItem, stock: e.target.value })}
                  />
                </div>
              ) : (
                <div className="flex items-center justify-center h-full text-xs text-muted-foreground italic">
                  Services have infinite stock
                </div>
              )}
            </div>

            {/* Category + SKU */}
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <label className="text-sm font-medium">Category</label>

                {categoryMode === "select" ? (
                  <div className="space-y-2">
                    <Select
                      value={newItem.category}
                      onValueChange={(val) => {
                        if (val === "__new__") {
                          setCategoryMode("new");
                          setNewCategoryName("");
                          return;
                        }
                        setNewItem({ ...newItem, category: val });
                      }}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Choose category" />
                      </SelectTrigger>
                      <SelectContent>
                        {categories.map((cat) => (
                          <SelectItem key={cat} value={cat}>
                            {cat}
                          </SelectItem>
                        ))}
                        <SelectItem value="__new__">+ Create new category…</SelectItem>
                      </SelectContent>
                    </Select>

                    <p className="text-[11px] text-muted-foreground">
                      Tip: choose from the list so you don’t retype categories.
                    </p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <Input
                      placeholder="New category name…"
                      value={newCategoryName}
                      onChange={(e) => setNewCategoryName(e.target.value)}
                      autoFocus
                    />
                    <div className="flex gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setCategoryMode("select");
                          setNewCategoryName("");
                        }}
                      >
                        Back
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        onClick={() => {
                          const c = newCategoryName.trim();
                          if (!c) return toast.error("Enter a category name");
                          setNewItem({ ...newItem, category: c });
                          setCategoryMode("select");
                          toast.success(`Category set: ${c}`);
                        }}
                      >
                        Use Category
                      </Button>
                    </div>
                  </div>
                )}
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium">SKU / Barcode</label>
                <div className="relative flex gap-2">
                  <Input
                    className="flex-1 font-mono"
                    placeholder="Scan or type..."
                    value={newItem.sku}
                    onChange={(e) => setNewItem({ ...newItem, sku: e.target.value })}
                  />
                  <Button
                    size="icon"
                    variant="outline"
                    onClick={() => setShowScanner(true)}
                    title="Scan Barcode"
                  >
                    <ScanLine className="w-4 h-4" />
                  </Button>
                </div>
              </div>
            </div>

            <Button
              className="w-full h-12 text-lg font-semibold bg-primary hover:bg-blue-600"
              onClick={() => saveProductMutation.mutate()}
              disabled={saveProductMutation.isPending || isUploading || !isAdmin}
            >
              {saveProductMutation.isPending ? (
                <Loader2 className="animate-spin" />
              ) : (
                <>
                  {editingProduct ? "Update Product" : "Create Product"}{" "}
                  {!navigator.onLine && (
                    <span className="text-xs ml-2 opacity-80">(Queued)</span>
                  )}
                </>
              )}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Scanner */}
      <BarcodeScanner
        isOpen={showScanner}
        onClose={() => setShowScanner(false)}
        onScan={handleScanSKU}
      />
    </div>
  );
};

const StatBox = ({ label, value, color, icon: Icon, onClick, active }: any) => (
  <motion.div
    initial={{ opacity: 0, y: 10 }}
    animate={{ opacity: 1, y: 0 }}
    role={onClick ? "button" : undefined}
    tabIndex={onClick ? 0 : undefined}
    onClick={onClick}
    onKeyDown={(e) => {
      if (!onClick) return;
      if (e.key === "Enter" || e.key === " ") onClick();
    }}
    className={cn(
      "p-4 rounded-xl bg-card border flex items-center justify-between shadow-sm select-none",
      onClick && "cursor-pointer hover:opacity-90 active:scale-[0.99] transition",
      active && "ring-2 ring-red-500/60",
      color
    )}
  >
    <div>
      <p className="text-xs text-muted-foreground font-medium uppercase tracking-wide">{label}</p>
      <p className="text-2xl font-bold mt-1">{value}</p>
    </div>
    <div className="p-2 bg-white/20 rounded-lg">
      <Icon className="w-5 h-5 opacity-80" />
    </div>
  </motion.div>
);
