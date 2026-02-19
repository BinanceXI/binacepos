import { supabase } from "@/lib/supabase";
import {
  getTenantScopeFromLocalUser,
  readScopedJSON,
  tenantScopeKey,
  writeScopedJSON,
} from "@/lib/tenantScope";

export type ExpenseType = "expense" | "owner_drawing";

export type Expense = {
  id: string;
  created_at: string;
  business_id: string | null;
  created_by?: string | null;
  source: string;
  occurred_at: string;
  category: string;
  notes: string | null;
  amount: number;
  payment_method: string | null;
  expense_type: ExpenseType;
  synced_at: string | null;
};

export type ExpenseRange = {
  from?: string; // ISO
  to?: string; // ISO
};

// Offline sync uses an "expense_queue" where each expense id is either queued for upsert or queued for delete.
type ExpenseQueueItem =
  | { id: string; op: "upsert"; expense: Expense; ts: number; lastError?: string; scope_key?: string | null }
  | { id: string; op: "delete"; ts: number; lastError?: string; scope_key?: string | null };

const DB_NAME = "binancexi_pos_expenses";
const DB_VERSION = 1;
const EXPENSES_STORE = "expenses";
const QUEUE_STORE = "expense_queue";

const LS_EXPENSES_KEY = "binancexi_expenses_v1";
const LS_QUEUE_KEY = "binancexi_expenses_queue_v1";

function isIdbAvailable() {
  return typeof indexedDB !== "undefined";
}

function currentScope() {
  return getTenantScopeFromLocalUser();
}

function currentScopeKey() {
  return tenantScopeKey(currentScope());
}

function expenseMatchesCurrentScope(expense: Partial<Expense & { scope_key?: string | null }>): boolean {
  const scope = currentScope();
  if (!scope) return true;

  const expectedScopeKey = tenantScopeKey(scope);
  const rowScopeKey = String((expense as any)?.scope_key || "").trim();
  if (rowScopeKey) return rowScopeKey === expectedScopeKey;

  const businessId = String(expense?.business_id || "").trim();
  return businessId ? businessId === scope.businessId : false;
}

function queueItemMatchesCurrentScope(item: ExpenseQueueItem): boolean {
  const scope = currentScope();
  if (!scope) return true;

  const expectedScopeKey = tenantScopeKey(scope);
  const itemScopeKey = String((item as any)?.scope_key || "").trim();
  if (itemScopeKey) return itemScopeKey === expectedScopeKey;

  if (item.op === "upsert") {
    return expenseMatchesCurrentScope(item.expense as any);
  }

  // Legacy unscoped delete items cannot be safely attributed; ignore for isolation.
  return false;
}

function loadLsExpensesMap(): Record<string, Expense> {
  return readScopedJSON<Record<string, Expense>>(LS_EXPENSES_KEY, {}, {
    scope: currentScope(),
    migrateLegacy: true,
  });
}

function saveLsExpensesMap(map: Record<string, Expense>) {
  writeScopedJSON(LS_EXPENSES_KEY, map, { scope: currentScope() });
}

function loadLsQueueMap(): Record<string, ExpenseQueueItem> {
  return readScopedJSON<Record<string, ExpenseQueueItem>>(LS_QUEUE_KEY, {}, {
    scope: currentScope(),
    migrateLegacy: true,
  });
}

function saveLsQueueMap(map: Record<string, ExpenseQueueItem>) {
  writeScopedJSON(LS_QUEUE_KEY, map, { scope: currentScope() });
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
      if (!db.objectStoreNames.contains(EXPENSES_STORE)) {
        db.createObjectStore(EXPENSES_STORE, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(QUEUE_STORE)) {
        db.createObjectStore(QUEUE_STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
  });
}

function reqToPromise<T>(req: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("IndexedDB request failed"));
  });
}

async function withStores<T>(
  mode: IDBTransactionMode,
  fn: (stores: { expenses: IDBObjectStore; queue: IDBObjectStore }) => Promise<T> | T
): Promise<T> {
  const db = await openDb();
  try {
    const tx = db.transaction([EXPENSES_STORE, QUEUE_STORE], mode);
    const expenses = tx.objectStore(EXPENSES_STORE);
    const queue = tx.objectStore(QUEUE_STORE);
    const result = await fn({ expenses, queue });

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

function normalizeMoney(n: any) {
  const num = typeof n === "number" ? n : Number(String(n ?? "").trim());
  if (!Number.isFinite(num)) return 0;
  return Math.round(num * 100) / 100;
}

function normalizeExpense(raw: Expense): Expense {
  const now = new Date().toISOString();
  const scope = currentScope();
  const expenseTypeRaw = (raw.expense_type || "expense") as any;
  const expenseType: ExpenseType =
  expenseTypeRaw === "owner_draw" ? "owner_drawing" : (expenseTypeRaw as ExpenseType);
  return {
    id: String(raw.id || "").trim(),
    created_at: raw.created_at || now,
    business_id: raw.business_id ?? scope?.businessId ?? null,
    created_by: raw.created_by ?? null,
    source: (raw.source || "pos").trim() || "pos",
    occurred_at: raw.occurred_at || now,
    category: String(raw.category || "").trim(),
    notes: raw.notes == null ? null : String(raw.notes),
    amount: normalizeMoney(raw.amount),
    payment_method: raw.payment_method == null ? null : String(raw.payment_method),
    expense_type: expenseType,
    synced_at: raw.synced_at ?? null,
  };
}

function isWithinRange(iso: string, range?: ExpenseRange) {
  if (!range?.from && !range?.to) return true;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return false;
  if (range.from) {
    const fromT = new Date(range.from).getTime();
    if (Number.isFinite(fromT) && t < fromT) return false;
  }
  if (range.to) {
    const toT = new Date(range.to).getTime();
    if (Number.isFinite(toT) && t > toT) return false;
  }
  return true;
}

async function upsertExpenseLocal(expense: Expense): Promise<void> {
  const normalized = normalizeExpense(expense);
  const scopeKey = currentScopeKey();
  if (!normalized.id) throw new Error("Missing expense id");
  if (!normalized.category) throw new Error("Missing category");
  if (normalized.amount <= 0) throw new Error("Amount must be greater than 0");

  const map = loadLsExpensesMap();
  map[normalized.id] = normalized;
  saveLsExpensesMap(map);

  if (!isIdbAvailable()) return;
  try {
    await withStores("readwrite", ({ expenses }) => {
      expenses.put({ ...(normalized as any), scope_key: scopeKey } as any);
    });
  } catch {
    // localStorage fallback already saved
  }
}

async function deleteExpenseLocal(id: string): Promise<void> {
  const key = String(id || "").trim();
  if (!key) return;

  const map = loadLsExpensesMap();
  delete map[key];
  saveLsExpensesMap(map);

  if (!isIdbAvailable()) return;
  try {
    await withStores("readwrite", ({ expenses }) => {
      expenses.delete(key);
    });
  } catch {
    // localStorage fallback already applied
  }
}

async function getExpenseLocal(id: string): Promise<Expense | null> {
  const key = String(id || "").trim();
  if (!key) return null;

  if (!isIdbAvailable()) {
    const map = loadLsExpensesMap();
    return map[key] || null;
  }

  try {
    const row = await withStores("readonly", async ({ expenses }) => {
      const res = await reqToPromise(expenses.get(key));
      return (res as any) || null;
    });
    if (!row) return null;
    return expenseMatchesCurrentScope(row as any) ? (row as Expense) : null;
  } catch {
    const map = loadLsExpensesMap();
    return map[key] || null;
  }
}

async function listExpensesLocal(): Promise<Expense[]> {
  if (!isIdbAvailable()) {
    const map = loadLsExpensesMap();
    return Object.values(map).filter((row) => expenseMatchesCurrentScope(row as any));
  }

  try {
    return await withStores("readonly", async ({ expenses }) => {
      if ("getAll" in expenses) {
        const res = await reqToPromise((expenses as any).getAll());
        return (res as any[]).filter((row) => expenseMatchesCurrentScope(row as any)) as Expense[];
      }

      const out: Expense[] = [];
      await new Promise<void>((resolve, reject) => {
        const cursorReq = (expenses as any).openCursor();
        cursorReq.onerror = () => reject(cursorReq.error || new Error("Cursor failed"));
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (!cursor) return resolve();
          out.push(cursor.value as any);
          cursor.continue();
        };
      });
      return out.filter((row) => expenseMatchesCurrentScope(row as any));
    });
  } catch {
    const map = loadLsExpensesMap();
    return Object.values(map).filter((row) => expenseMatchesCurrentScope(row as any));
  }
}

async function upsertQueueLocal(item: ExpenseQueueItem): Promise<void> {
  const key = String(item?.id || "").trim();
  if (!key) return;
  const scopeKey = currentScopeKey();

  const map = loadLsQueueMap();
  map[key] = { ...item, id: key, scope_key: scopeKey };
  saveLsQueueMap(map);
  notifyQueueChanged();

  if (!isIdbAvailable()) return;
  try {
    await withStores("readwrite", ({ queue }) => {
      queue.put(map[key] as any);
    });
  } catch {
    // localStorage fallback already saved
  }
}

async function deleteQueueLocal(id: string): Promise<void> {
  const key = String(id || "").trim();
  if (!key) return;

  const map = loadLsQueueMap();
  delete map[key];
  saveLsQueueMap(map);
  notifyQueueChanged();

  if (!isIdbAvailable()) return;
  try {
    await withStores("readwrite", ({ queue }) => {
      queue.delete(key);
    });
  } catch {
    // localStorage fallback already applied
  }
}

async function listQueueLocal(): Promise<ExpenseQueueItem[]> {
  if (!isIdbAvailable()) {
    return Object.values(loadLsQueueMap()).filter((item) => queueItemMatchesCurrentScope(item));
  }

  try {
    return await withStores("readonly", async ({ queue }) => {
      if ("getAll" in queue) {
        const res = await reqToPromise((queue as any).getAll());
        return (res as any[]).filter((item) => queueItemMatchesCurrentScope(item as any)) as ExpenseQueueItem[];
      }

      const out: ExpenseQueueItem[] = [];
      await new Promise<void>((resolve, reject) => {
        const cursorReq = (queue as any).openCursor();
        cursorReq.onerror = () => reject(cursorReq.error || new Error("Cursor failed"));
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (!cursor) return resolve();
          out.push(cursor.value as any);
          cursor.continue();
        };
      });
      return out.filter((item) => queueItemMatchesCurrentScope(item as any));
    });
  } catch {
    return Object.values(loadLsQueueMap()).filter((item) => queueItemMatchesCurrentScope(item));
  }
}

function nowTs() {
  return Date.now();
}

export async function listExpenses(range?: ExpenseRange): Promise<Expense[]> {
  // Best-effort pull so other devices see new items
  if (navigator.onLine) {
    try {
      await pullRecentExpenses(90);
    } catch {
      // ignore
    }
  }

  const all = await listExpensesLocal();
  return (all || [])
    .map(normalizeExpense)
    .filter((e) => isWithinRange(e.occurred_at, range))
    .sort((a, b) => b.occurred_at.localeCompare(a.occurred_at));
}

export async function addExpense(expense: Expense): Promise<void> {
  const next = normalizeExpense({
    ...expense,
    synced_at: null,
  });

  await upsertExpenseLocal(next);
  await upsertQueueLocal({ id: next.id, op: "upsert", expense: next, ts: nowTs() });
}

export async function updateExpense(id: string, patch: Partial<Expense>): Promise<void> {
  const existing = await getExpenseLocal(id);
  if (!existing) throw new Error("Expense not found");

  const merged = normalizeExpense({
    ...existing,
    ...patch,
    id: existing.id,
    created_at: existing.created_at,
    synced_at: null,
  });

  await upsertExpenseLocal(merged);
  await upsertQueueLocal({ id: merged.id, op: "upsert", expense: merged, ts: nowTs() });
}

export async function deleteExpense(id: string): Promise<void> {
  const key = String(id || "").trim();
  if (!key) return;

  await deleteExpenseLocal(key);
  await upsertQueueLocal({ id: key, op: "delete", ts: nowTs() });
}

export function getExpenseQueueCount(): number {
  try {
    return Object.keys(loadLsQueueMap()).length;
  } catch {
    return 0;
  }
}

export async function syncExpenses(): Promise<void> {
  if (!navigator.onLine) return;

  const queue = await listQueueLocal();
  if (!queue.length) {
    // Best-effort pull so new devices get data when online
    try {
      await pullRecentExpenses(90);
    } catch {
      // pull failures shouldn't block the rest of the app
    }
    return;
  }

  for (const item of queue.sort((a, b) => (a.ts || 0) - (b.ts || 0))) {
    try {
      if (item.op === "upsert") {
        const row: any = { ...normalizeExpense(item.expense), synced_at: new Date().toISOString() };
        // Do not overwrite server-filled created_by unless explicitly set
        if (row.created_by == null) delete row.created_by;
        if (row.business_id == null) delete row.business_id;

        const { error } = await supabase.from("expenses").upsert(row, { onConflict: "id" });
        if (error) throw error;

        await upsertExpenseLocal(row as Expense);
        await deleteQueueLocal(item.id);
      }

      if (item.op === "delete") {
        const { error } = await supabase.from("expenses").delete().eq("id", item.id);
        if (error) throw error;
        await deleteQueueLocal(item.id);
      }
    } catch (e: any) {
      const msg = e?.message || String(e);
      await upsertQueueLocal({ ...item, lastError: msg } as any);
    }
  }

  // Best-effort pull after pushing
  try {
    await pullRecentExpenses(90);
  } catch {
    // ignore
  }
}

async function pullRecentExpenses(daysBack: number): Promise<void> {
  if (!navigator.onLine) return;


  const since = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000).toISOString();
  const queued = loadLsQueueMap();

  const { data, error } = await supabase
    .from("expenses")
    .select(
      "id, created_at, business_id, created_by, source, occurred_at, category, notes, amount, payment_method, expense_type, synced_at"
    )
    .gte("occurred_at", since)
    .order("occurred_at", { ascending: false })
    .limit(1000);

  if (error) throw error;

  for (const row of (data as any[]) || []) {
    const id = String(row?.id || "").trim();
    if (!id) continue;
    if (queued[id]) continue; // don't overwrite local pending changes
    await upsertExpenseLocal(row as Expense);
  }
}
