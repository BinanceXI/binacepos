import { removeKeyAcrossScopes } from "@/lib/tenantScope";

const CORE_KEYS = [
  "binancexi_user",
  "platform_admin_session_backup_v1",
  "platform_admin_impersonation_v1",
  "REACT_QUERY_OFFLINE_CACHE",
] as const;

const OFFLINE_CACHE_KEYS = [
  "binancexi_offline_queue",
  "binancexi_held_sales",
  "binancexi_orders_cache_v1",
  "binancexi_expenses_v1",
  "binancexi_expenses_queue_v1",
  "binancexi_expenses_queue_count_v1",
  "binancexi_service_bookings_v1",
  "binancexi_products_mutation_queue_v2",
  "binancexi_feedback_queue_v1",
  "binancexi_thermal_print_queue_v1",
] as const;

const INDEXED_DB_BASES = [
  "binancexi_pos_expenses",
  "binancexi_pos_bookings",
  "binancexi_pos_auth",
] as const;

function safeRemoveItem(key: string) {
  try {
    localStorage.removeItem(key);
  } catch {
    // ignore
  }
}

function collectSupabaseTokenKeys(): string[] {
  const out: string[] = [];
  try {
    for (let i = 0; i < localStorage.length; i += 1) {
      const k = localStorage.key(i);
      if (!k) continue;
      if (k.startsWith("sb-") && k.endsWith("-auth-token")) out.push(k);
    }
  } catch {
    return out;
  }
  return out;
}

function deleteDb(name: string): Promise<void> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.deleteDatabase(name);
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
      req.onblocked = () => resolve();
    } catch {
      resolve();
    }
  });
}

export function clearClientStorage(opts?: { includeDemoExpires?: boolean }) {
  if (typeof window === "undefined") return;

  for (const k of CORE_KEYS) safeRemoveItem(k);
  for (const k of OFFLINE_CACHE_KEYS) removeKeyAcrossScopes(k);

  if (opts?.includeDemoExpires) {
    safeRemoveItem("binancexi_demo_expires_at");
  }

  for (const k of collectSupabaseTokenKeys()) safeRemoveItem(k);
}

export async function clearClientIndexedDb() {
  if (typeof indexedDB === "undefined") return;

  const targets = new Set<string>(INDEXED_DB_BASES);

  const idbAny = indexedDB as unknown as {
    databases?: () => Promise<Array<{ name?: string }>>;
  };

  if (typeof idbAny.databases === "function") {
    try {
      const dbs = await idbAny.databases();
      for (const row of dbs || []) {
        const name = String(row?.name || "").trim();
        if (!name) continue;
        for (const base of INDEXED_DB_BASES) {
          if (name === base || name.startsWith(`${base}:`) || name.startsWith(`${base}_`)) {
            targets.add(name);
          }
        }
      }
    } catch {
      // ignore, we'll still delete the base names below
    }
  }

  for (const name of targets) {
    await deleteDb(name);
  }
}
