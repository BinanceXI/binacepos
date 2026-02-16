// 1. User Types
export type UserRole = "admin" | "cashier";

export interface UserPermissions {
  allowRefunds: boolean;
  allowVoid: boolean;
  allowPriceEdit: boolean;
  allowDiscount: boolean;
  allowReports: boolean;
  allowInventory: boolean;
  allowSettings: boolean;
  allowEditReceipt: boolean;
}

export interface User {
  id: string;
  name: string;
  username?: string;
  email?: string;
  role: UserRole;
  avatar?: string;
  permissions: UserPermissions | string[] | any;
  active: boolean;
}

// 2. Product Types
export type ProductType = "good" | "service" | "physical";

export interface Product {
  id: string;
  name: string;
  sku?: string;
  barcode?: string;
  price: number;
  category: string;
  type: ProductType;

  // Database Columns (snake_case)
  cost_price?: number;
  stock_quantity?: number;
  image_url?: string;
  low_stock_threshold?: number;
  shortcut_code?: string;
  is_variable_price?: boolean;
  requires_note?: boolean;

  // ✅ Frontend Aliases (CamelCase)
  image?: string; // Maps to image_url
  lowStockThreshold?: number; // Maps to low_stock_threshold
  shortcutCode?: string; // Maps to shortcut_code
  stock?: number; // Maps to stock_quantity
  cost?: number; // Maps to cost_price
}

// 3. Cart & Sales Types
export type PaymentMethod = "cash" | "card" | "ecocash" | "mixed";

// ✅ IMPORTANT: This fixes your red lineId + fixes service/custom items bugs
export interface CartItem {
  lineId: string; // ✅ NEW

  product: Product;
  quantity: number;

  discount: number;
  discountType?: "percentage" | "fixed";

  customDescription?: string;
  customPrice?: number;
}

export interface Payment {
  method: PaymentMethod | string;
  amount: number;
  reference?: string;
}

export interface Sale {
  id: string;
  items: CartItem[];
  subtotal: number;
  tax: number;
  discount: number;
  total: number;
  payments: Payment[];
  cashier: User;
  cashierId: string;
  customerName?: string;
  timestamp: Date | string;
  status: "completed" | "refunded" | "voided" | "held";
  synced?: boolean;
}

// 4. Other Types
export type SyncStatus = "online" | "offline" | "syncing" | "error";
export type POSMode = "retail" | "service";

export interface Category {
  id: string;
  name: string;
  color?: string;
}

export interface Discount {
  id: string;
  name: string;
  type: "percentage" | "fixed";
  value: number;
  code?: string;
  active: boolean;
}
