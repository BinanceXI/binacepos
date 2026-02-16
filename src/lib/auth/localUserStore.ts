import type { PasswordHash } from "@/lib/auth/passwordKdf";

export type LocalAuthUser = {
  id: string;
  username: string;
  full_name: string | null;
  role: "platform_admin" | "admin" | "cashier";
  permissions: any;
  business_id?: string | null;
  active: boolean;
  password: PasswordHash;
  updated_at: string; // ISO
};

const DB_NAME = "binancexi_pos_auth";
const DB_VERSION = 1;
const STORE = "users";

const LS_FALLBACK_KEY = "binancexi_auth_users_v1";

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

function loadLsMap(): Record<string, LocalAuthUser> {
  return safeJSONParse<Record<string, LocalAuthUser>>(localStorage.getItem(LS_FALLBACK_KEY), {});
}

function saveLsMap(map: Record<string, LocalAuthUser>) {
  localStorage.setItem(LS_FALLBACK_KEY, JSON.stringify(map));
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error || new Error("IndexedDB open failed"));
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "username" });
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

export async function getLocalUser(username: string): Promise<LocalAuthUser | null> {
  const u = String(username || "").trim().toLowerCase();
  if (!u) return null;

  if (!isIdbAvailable()) {
    const map = loadLsMap();
    return map[u] || null;
  }

  try {
    return await withStore("readonly", async (store) => {
      const res = await reqToPromise(store.get(u));
      return (res as any) || null;
    });
  } catch {
    // fallback
    const map = loadLsMap();
    return map[u] || null;
  }
}

export async function upsertLocalUser(user: LocalAuthUser): Promise<void> {
  const u = String(user?.username || "").trim().toLowerCase();
  if (!u) throw new Error("Missing username");

  const normalized: LocalAuthUser = { ...user, username: u };

  if (!isIdbAvailable()) {
    const map = loadLsMap();
    map[u] = normalized;
    saveLsMap(map);
    return;
  }

  try {
    await withStore("readwrite", async (store) => {
      store.put(normalized as any);
    });
  } catch {
    const map = loadLsMap();
    map[u] = normalized;
    saveLsMap(map);
  }
}

export async function deleteLocalUser(username: string): Promise<void> {
  const u = String(username || "").trim().toLowerCase();
  if (!u) return;

  if (!isIdbAvailable()) {
    const map = loadLsMap();
    delete map[u];
    saveLsMap(map);
    return;
  }

  try {
    await withStore("readwrite", async (store) => {
      store.delete(u);
    });
  } catch {
    const map = loadLsMap();
    delete map[u];
    saveLsMap(map);
  }
}

export async function listLocalUsers(): Promise<LocalAuthUser[]> {
  if (!isIdbAvailable()) {
    const map = loadLsMap();
    return Object.values(map);
  }

  try {
    return await withStore("readonly", async (store) => {
      // getAll is widely supported in modern WebViews; fallback to cursor if missing.
      if ("getAll" in store) {
        const res = await reqToPromise((store as any).getAll());
        return (res as any[]) as LocalAuthUser[];
      }

      const out: LocalAuthUser[] = [];
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
      return out;
    });
  } catch {
    const map = loadLsMap();
    return Object.values(map);
  }
}

export async function renameLocalUser(oldUsername: string, newUsername: string): Promise<void> {
  const from = String(oldUsername || "").trim().toLowerCase();
  const to = String(newUsername || "").trim().toLowerCase();
  if (!from || !to || from === to) return;

  const existing = await getLocalUser(from);
  if (!existing) return;

  const next: LocalAuthUser = { ...existing, username: to, updated_at: new Date().toISOString() };

  await upsertLocalUser(next);
  await deleteLocalUser(from);
}
