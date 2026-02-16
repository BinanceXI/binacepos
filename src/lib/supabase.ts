// File: src/lib/supabase.ts
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// 1) Read keys from Vite env
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

// 2) Hard safety: never create a client with empty strings (causes white screens / crashes)
export const supabase: SupabaseClient = (() => {
  if (!supabaseUrl || !supabaseAnonKey) {
    console.error(
      "⚠️ SUPABASE ERROR: Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY. Check your .env (local) or Vercel Environment Variables."
    );

    // Return a harmless dummy client so the app stays alive (queries will fail gracefully)
    return createClient("https://invalid.supabase.co", "invalid-anon-key");
  }

  return createClient(supabaseUrl, supabaseAnonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  });
})();

// 3) Types (keep these — they help your app + queries)

// Products
export interface Product {
  id: string;
  name: string;
  category: string | null;
  type: "good" | "service" | "physical";
  description?: string | null;
  price: number;

  // DB columns
  cost_price?: number;
  stock_quantity?: number;
  low_stock_threshold?: number;
  is_variable_price?: boolean;
  requires_note?: boolean;

  created_at?: string;
}

// Orders
export interface Order {
  id: string;
  cashier_id: string;
  customer_name: string | null;
  customer_contact?: string | null;

  total_amount: number;
  payment_method: "cash" | "ecocash" | "card" | "mixed";
  status: "completed" | "voided" | "refunded" | "held";

  // ✅ receipt fields used by QR verification
  receipt_id?: string | null;
  receipt_number?: string | null;

  created_at: string;
}

// Order Items
export interface OrderItem {
  id: string;
  order_id: string;
  product_id: string;
  product_name: string;
  quantity: number;
  price_at_sale: number;

  cost_at_sale?: number;
  service_note?: string | null;
}

// Profiles
export interface Profile {
  id: string;
  full_name: string | null;
  role: "platform_admin" | "admin" | "cashier";
  permissions: any;
  business_id?: string | null;
}
