import type { QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/lib/supabase";
import { ensureSupabaseSession } from "@/lib/supabaseSession";

export const PRODUCTS_QUEUE_KEY = "binancexi_products_mutation_queue_v2";

export type ProductUpsertPayload = {
  id: string;
  name: string;
  price: number;
  cost_price: number;
  stock_quantity: number;
  type: string;
  category: string;
  sku?: string | null;
  shortcut_code?: string | null;
  image_url?: string | null;
  barcode?: string | null;
  low_stock_threshold?: number | null;
  is_variable_price?: boolean | null;
  requires_note?: boolean | null;
  is_archived?: boolean | null;
};

export type InventoryOfflineMutation =
  | { kind: "upsert_product"; payload: ProductUpsertPayload; ts: number }
  | { kind: "archive_product"; id: string; ts: number }
  | { kind: "set_stock"; id: string; stock_quantity: number; ts: number };

function safeParse<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function notifyQueueChanged() {
  try {
    window.dispatchEvent(new Event("binancexi:queue_changed"));
  } catch {
    // ignore
  }
}

export function enqueueInventoryMutation(m: InventoryOfflineMutation) {
  const q = safeParse<InventoryOfflineMutation[]>(localStorage.getItem(PRODUCTS_QUEUE_KEY), []);
  q.push(m);
  localStorage.setItem(PRODUCTS_QUEUE_KEY, JSON.stringify(q));
  notifyQueueChanged();
}

export function readInventoryQueue(): InventoryOfflineMutation[] {
  return safeParse<InventoryOfflineMutation[]>(localStorage.getItem(PRODUCTS_QUEUE_KEY), []);
}

function writeInventoryQueue(next: InventoryOfflineMutation[]) {
  localStorage.setItem(PRODUCTS_QUEUE_KEY, JSON.stringify(next));
  notifyQueueChanged();
}

export function getInventoryQueueCount(): number {
  return readInventoryQueue().length;
}

export async function processInventoryQueue(opts?: { silent?: boolean; queryClient?: QueryClient }) {
  const silent = !!opts?.silent;
  const queryClient = opts?.queryClient;

  if (!navigator.onLine) return { processed: 0, failed: 0 };

  const queue = readInventoryQueue();
  if (!queue.length) return { processed: 0, failed: 0 };

  const sessionRes = await ensureSupabaseSession();
  if (!sessionRes.ok) {
    if (!silent) toast.error(`Sync issue — check network or sign in again.`);
    // DO NOT return — still attempt sync using anon role if allowed by RLS
  }

  const toastId = silent ? null : toast.loading(`Syncing ${queue.length} inventory changes...`);
  const failed: InventoryOfflineMutation[] = [];

  try {
    for (const m of queue) {
      try {
        if (m.kind === "upsert_product") {
          const { error } = await supabase.from("products").upsert(m.payload, { onConflict: "id" });
          if (error) throw error;
        }

        if (m.kind === "archive_product") {
          const { error } = await supabase.from("products").update({ is_archived: true }).eq("id", m.id);
          if (error) throw error;
        }

        if (m.kind === "set_stock") {
          const { error } = await supabase.from("products").update({ stock_quantity: m.stock_quantity }).eq("id", m.id);
          if (error) throw error;
        }
      } catch (e) {
        console.error("Inventory queue item failed", m, e);
        failed.push(m);
      }
    }

    writeInventoryQueue(failed);

    if (!failed.length) {
      if (!silent) toast.success("Inventory synced");
      if (queryClient) queryClient.invalidateQueries({ queryKey: ["products"] });
    } else {
      if (!silent) toast.error(`${failed.length} inventory changes failed to sync`);
    }

    return { processed: queue.length - failed.length, failed: failed.length };
  } finally {
    if (toastId != null) toast.dismiss(toastId);
  }
}
