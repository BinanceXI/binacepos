import { supabase } from "@/lib/supabase";
import { ensureSupabaseSession } from "@/lib/supabaseSession";

export type ServiceBookingStatus = "booked" | "completed" | "cancelled";

export type ServiceBooking = {
  id: string;
  service_id: string;
  service_name: string;
  customer_name: string | null;
  booking_date_time: string; // ISO
  deposit_amount: number;
  total_price: number;
  status: ServiceBookingStatus;
  created_at: string; // ISO
  updated_at: string; // ISO
};

export type LocalServiceBooking = ServiceBooking & {
  synced: boolean;
  lastError?: string;
};

const DB_NAME = "binancexi_pos_bookings";
const DB_VERSION = 1;
const STORE = "service_bookings";

const LS_FALLBACK_KEY = "binancexi_service_bookings_v1";

function isIdbAvailable() {
  return typeof indexedDB !== "undefined";
}

function safeJSONParse<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function loadLsMap(): Record<string, LocalServiceBooking> {
  return safeJSONParse<Record<string, LocalServiceBooking>>(localStorage.getItem(LS_FALLBACK_KEY), {});
}

function saveLsMap(map: Record<string, LocalServiceBooking>) {
  localStorage.setItem(LS_FALLBACK_KEY, JSON.stringify(map));
}

function notifyQueueChanged() {
  try {
    window.dispatchEvent(new Event("binancexi:queue_changed"));
  } catch {
    // ignore
  }
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error || new Error("IndexedDB open failed"));
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => Promise<T> | T
): Promise<T> {
  const db = await openDb();
  try {
    const tx = db.transaction(STORE, mode);
    const store = tx.objectStore(STORE);
    const result = await fn(store);

    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error("IndexedDB transaction failed"));
      tx.onabort = () => reject(tx.error || new Error("IndexedDB transaction aborted"));
    });

    return result;
  } finally {
    db.close();
  }
}

function reqToPromise<T>(req: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("IndexedDB request failed"));
  });
}

export function newServiceBookingId() {
  // @ts-ignore
  return globalThis.crypto?.randomUUID?.() ?? `bk-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function normalizeMoney(n: any) {
  const num = typeof n === "number" ? n : Number(String(n || "").trim());
  if (!Number.isFinite(num)) return 0;
  return Math.round(num * 100) / 100;
}

function toRemoteRow(b: LocalServiceBooking): ServiceBooking {
  const { synced: _synced, lastError: _lastError, ...row } = b;
  return row;
}

const LEGACY_SERVICE_ID_PREFIX = "service_id:";

function withLegacyServiceIdTag(serviceId: string, serviceName: string) {
  const id = String(serviceId || "").trim();
  const name = String(serviceName || "").trim();
  if (!id) return name || "Service";
  if (!name) return `${LEGACY_SERVICE_ID_PREFIX}${id}`;
  return `${name} | ${LEGACY_SERVICE_ID_PREFIX}${id}`;
}

function parseLegacyServiceId(serviceDescription: unknown): string | null {
  const raw = String(serviceDescription || "").trim();
  if (!raw) return null;
  const m = raw.match(/service_id:([0-9a-f-]{8,})/i);
  return m?.[1] ? String(m[1]).toLowerCase() : null;
}

function isMissingColumnError(err: unknown) {
  const code = String((err as any)?.code || "");
  const msg = String((err as any)?.message || "").toLowerCase();
  return code === "42703" || (msg.includes("column") && msg.includes("does not exist"));
}

function toRemoteRowModern(b: LocalServiceBooking) {
  return toRemoteRow(b);
}

function toRemoteRowLegacy(b: LocalServiceBooking) {
  const row = toRemoteRow(b);
  const total = normalizeMoney(row.total_price);
  const deposit = normalizeMoney(row.deposit_amount);
  const remaining = Math.max(0, normalizeMoney(total - deposit));

  return {
    id: row.id,
    service_name: row.service_name,
    service_description: withLegacyServiceIdTag(row.service_id, row.service_name),
    customer_name: row.customer_name,
    booking_date_time: row.booking_date_time,
    total_amount: total,
    deposit_paid: deposit,
    remaining_balance: remaining,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export async function listLocalServiceBookings(): Promise<LocalServiceBooking[]> {
  if (!isIdbAvailable()) {
    const map = loadLsMap();
    return Object.values(map).sort((a, b) => a.booking_date_time.localeCompare(b.booking_date_time));
  }

  try {
    return await withStore("readonly", async (store) => {
      if ("getAll" in store) {
        const res = await reqToPromise((store as any).getAll());
        return (res as any[] as LocalServiceBooking[]).sort((a, b) =>
          a.booking_date_time.localeCompare(b.booking_date_time)
        );
      }

      const out: LocalServiceBooking[] = [];
      await new Promise<void>((resolve, reject) => {
        const cursorReq = store.openCursor();
        cursorReq.onerror = () => reject(cursorReq.error || new Error("Cursor failed"));
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (!cursor) return resolve();
          out.push(cursor.value as any);
          cursor.continue();
        };
      });
      return out.sort((a, b) => a.booking_date_time.localeCompare(b.booking_date_time));
    });
  } catch {
    const map = loadLsMap();
    return Object.values(map).sort((a, b) => a.booking_date_time.localeCompare(b.booking_date_time));
  }
}

export async function getLocalServiceBooking(id: string): Promise<LocalServiceBooking | null> {
  const key = String(id || "").trim();
  if (!key) return null;

  if (!isIdbAvailable()) {
    const map = loadLsMap();
    return map[key] || null;
  }

  try {
    return await withStore("readonly", async (store) => {
      const res = await reqToPromise(store.get(key));
      return (res as any) || null;
    });
  } catch {
    const map = loadLsMap();
    return map[key] || null;
  }
}

export async function upsertLocalServiceBooking(booking: LocalServiceBooking): Promise<void> {
  const key = String(booking?.id || "").trim();
  if (!key) throw new Error("Missing booking id");

  const normalized: LocalServiceBooking = { ...booking, id: key };

  if (!isIdbAvailable()) {
    const map = loadLsMap();
    map[key] = normalized;
    saveLsMap(map);
    notifyQueueChanged();
    return;
  }

  try {
    await withStore("readwrite", async (store) => {
      store.put(normalized as any);
    });
  } catch {
    const map = loadLsMap();
    map[key] = normalized;
    saveLsMap(map);
  }

  notifyQueueChanged();
}

export async function deleteLocalServiceBooking(id: string): Promise<void> {
  const key = String(id || "").trim();
  if (!key) return;

  if (!isIdbAvailable()) {
    const map = loadLsMap();
    delete map[key];
    saveLsMap(map);
    notifyQueueChanged();
    return;
  }

  try {
    await withStore("readwrite", async (store) => {
      store.delete(key);
    });
  } catch {
    const map = loadLsMap();
    delete map[key];
    saveLsMap(map);
  }

  notifyQueueChanged();
}

export async function pushUnsyncedServiceBookings(): Promise<{ pushed: number; failed: number }> {
  if (!navigator.onLine) return { pushed: 0, failed: 0 };

  const all = await listLocalServiceBookings();
  const unsynced = all.filter((b) => !b.synced);
  if (!unsynced.length) return { pushed: 0, failed: 0 };

  const sessionRes = await ensureSupabaseSession();
  if (!sessionRes.ok) {
    const msg = sessionRes.error || "No active session";
    await Promise.all(
      unsynced.map((b) =>
        upsertLocalServiceBooking({
          ...b,
          synced: false,
          lastError: msg,
          updated_at: b.updated_at || new Date().toISOString(),
        })
      )
    );
    return { pushed: 0, failed: unsynced.length };
  }

  let data: any[] | null = null;
  let error: any = null;

  const modernRes = await supabase
    .from("service_bookings")
    .upsert(unsynced.map(toRemoteRowModern) as any, { onConflict: "id" })
    .select("id, updated_at");
  data = (modernRes.data as any[]) || null;
  error = modernRes.error;

  // Live DB compatibility: some projects still use legacy service_bookings columns.
  if (error && isMissingColumnError(error)) {
    const legacyRes = await supabase
      .from("service_bookings")
      .upsert(unsynced.map(toRemoteRowLegacy) as any, { onConflict: "id" })
      .select("id, updated_at");
    data = (legacyRes.data as any[]) || null;
    error = legacyRes.error;
  }

  if (error) {
    const msg = error?.message || String(error);
    await Promise.all(
      unsynced.map((b) =>
        upsertLocalServiceBooking({
          ...b,
          synced: false,
          lastError: msg,
          updated_at: b.updated_at || new Date().toISOString(),
        })
      )
    );
    return { pushed: 0, failed: unsynced.length };
  }

  const updatedById = new Map<string, string>();
  for (const row of (data as any[]) || []) {
    if (row?.id) updatedById.set(String(row.id), String(row.updated_at || ""));
  }

  await Promise.all(
    unsynced.map((b) => {
      const serverUpdatedAt = updatedById.get(b.id);
      return upsertLocalServiceBooking({
        ...b,
        synced: true,
        lastError: undefined,
        updated_at: serverUpdatedAt || b.updated_at || new Date().toISOString(),
      });
    })
  );

  return { pushed: unsynced.length, failed: 0 };
}

export async function getUnsyncedServiceBookingsCount(): Promise<number> {
  try {
    const all = await listLocalServiceBookings();
    return all.filter((b) => !b.synced).length;
  } catch {
    return 0;
  }
}

export async function pullRecentServiceBookings(daysBack = 30): Promise<{ pulled: number }> {
  if (!navigator.onLine) return { pulled: 0 };

  const sessionRes = await ensureSupabaseSession();
  if (!sessionRes.ok) return { pulled: 0 };

  const since = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000).toISOString();

  const modernSelect =
    "id, service_id, service_name, customer_name, booking_date_time, deposit_amount, total_price, status, created_at, updated_at";
  const legacySelect =
    "id, service_name, service_description, customer_name, booking_date_time, total_amount, deposit_paid, remaining_balance, status, created_at, updated_at";

  let data: any[] | null = null;
  let error: any = null;

  const modernRes = await supabase
    .from("service_bookings")
    .select(modernSelect)
    .gte("booking_date_time", since)
    .order("booking_date_time", { ascending: true })
    .limit(500);
  data = (modernRes.data as any[]) || null;
  error = modernRes.error;

  if (error && isMissingColumnError(error)) {
    const legacyRes = await supabase
      .from("service_bookings")
      .select(legacySelect)
      .gte("booking_date_time", since)
      .order("booking_date_time", { ascending: true })
      .limit(500);
    data = (legacyRes.data as any[]) || null;
    error = legacyRes.error;
  }

  if (error) throw error;

  const local = await listLocalServiceBookings();
  const localById = new Map(local.map((b) => [b.id, b]));

  let pulled = 0;
  for (const row of (data as any[]) || []) {
    const id = String(row.id || "");
    if (!id) continue;

    const existing = localById.get(id);
    if (existing && !existing.synced) continue; // don't overwrite local pending changes

    const next: LocalServiceBooking = {
      id,
      service_id:
        String(row.service_id || "").trim() ||
        parseLegacyServiceId(row.service_description) ||
        String(existing?.service_id || "").trim() ||
        id,
      service_name: String(row.service_name || existing?.service_name || "Service"),
      customer_name: row.customer_name == null ? null : String(row.customer_name),
      booking_date_time: String(row.booking_date_time || row.created_at || new Date().toISOString()),
      deposit_amount: normalizeMoney(
        row.deposit_amount != null ? row.deposit_amount : row.deposit_paid
      ),
      total_price: normalizeMoney(
        row.total_price != null ? row.total_price : row.total_amount
      ),
      status: (row.status || "booked") as ServiceBookingStatus,
      created_at: String(row.created_at || new Date().toISOString()),
      updated_at: String(row.updated_at || row.created_at || new Date().toISOString()),
      synced: true,
    };

    if (!existing || existing.updated_at < next.updated_at) {
      await upsertLocalServiceBooking(next);
      pulled += 1;
    }
  }

  return { pulled };
}
