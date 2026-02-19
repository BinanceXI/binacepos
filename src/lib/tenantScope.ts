export type TenantScope = {
  businessId: string;
  userId: string;
};

const USER_KEY = "binancexi_user";

function safeJSONParse<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function normalizeScope(input: {
  id?: unknown;
  user_id?: unknown;
  business_id?: unknown;
} | null | undefined): TenantScope | null {
  const userId = String(input?.id ?? input?.user_id ?? "").trim();
  const businessId = String(input?.business_id ?? "").trim();
  if (!userId || !businessId) return null;
  return { businessId, userId };
}

export function getTenantScopeFromUser(
  user: { id?: unknown; user_id?: unknown; business_id?: unknown } | null | undefined
): TenantScope | null {
  return normalizeScope(user);
}

export function getTenantScopeFromLocalUser(): TenantScope | null {
  if (typeof window === "undefined") return null;
  const raw = localStorage.getItem(USER_KEY);
  const parsed = safeJSONParse<{ id?: unknown; business_id?: unknown }>(raw);
  return normalizeScope(parsed);
}

export function resolveTenantScope(
  user?: { id?: unknown; user_id?: unknown; business_id?: unknown } | null
): TenantScope | null {
  return normalizeScope(user) || getTenantScopeFromLocalUser();
}

export function tenantScopeKey(scope: TenantScope | null | undefined): string | null {
  if (!scope?.businessId || !scope?.userId) return null;
  return `tenant:${scope.businessId}:user:${scope.userId}`;
}

export function scopedStorageKey(
  baseKey: string,
  scope?: TenantScope | null
): string {
  const scopeKey = tenantScopeKey(scope ?? getTenantScopeFromLocalUser());
  if (!scopeKey) return baseKey;
  return `${scopeKey}:${baseKey}`;
}

function parseWithFallback<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function readScopedJSON<T>(
  baseKey: string,
  fallback: T,
  opts?: {
    scope?: TenantScope | null;
    migrateLegacy?: boolean;
  }
): T {
  if (typeof window === "undefined") return fallback;

  const scope = opts?.scope ?? getTenantScopeFromLocalUser();
  const key = scopedStorageKey(baseKey, scope);

  const scopedRaw = localStorage.getItem(key);
  if (scopedRaw != null) {
    return parseWithFallback(scopedRaw, fallback);
  }

  const shouldMigrateLegacy = opts?.migrateLegacy !== false;
  if (!shouldMigrateLegacy || key === baseKey) return fallback;

  const legacyRaw = localStorage.getItem(baseKey);
  if (legacyRaw == null) return fallback;

  const parsed = parseWithFallback(legacyRaw, fallback);
  try {
    localStorage.setItem(key, JSON.stringify(parsed));
  } catch {
    // ignore quota failures
  }

  return parsed;
}

export function writeScopedJSON<T>(
  baseKey: string,
  value: T,
  opts?: { scope?: TenantScope | null }
) {
  if (typeof window === "undefined") return;
  const scope = opts?.scope ?? getTenantScopeFromLocalUser();
  const key = scopedStorageKey(baseKey, scope);
  localStorage.setItem(key, JSON.stringify(value));
}

export function readScopedString(
  baseKey: string,
  fallback: string,
  opts?: {
    scope?: TenantScope | null;
    migrateLegacy?: boolean;
  }
): string {
  if (typeof window === "undefined") return fallback;

  const scope = opts?.scope ?? getTenantScopeFromLocalUser();
  const key = scopedStorageKey(baseKey, scope);
  const scoped = localStorage.getItem(key);
  if (scoped != null) return scoped;

  const shouldMigrateLegacy = opts?.migrateLegacy !== false;
  if (!shouldMigrateLegacy || key === baseKey) return fallback;

  const legacy = localStorage.getItem(baseKey);
  if (legacy == null) return fallback;

  try {
    localStorage.setItem(key, legacy);
  } catch {
    // ignore
  }

  return legacy;
}

export function writeScopedString(
  baseKey: string,
  value: string,
  opts?: { scope?: TenantScope | null }
) {
  if (typeof window === "undefined") return;
  const scope = opts?.scope ?? getTenantScopeFromLocalUser();
  const key = scopedStorageKey(baseKey, scope);
  localStorage.setItem(key, value);
}

export function removeKeyAcrossScopes(baseKey: string) {
  if (typeof window === "undefined") return;

  const toDelete: string[] = [baseKey];
  const suffix = `:${baseKey}`;
  for (let i = 0; i < localStorage.length; i += 1) {
    const k = localStorage.key(i);
    if (!k) continue;
    if (k.endsWith(suffix)) toDelete.push(k);
  }

  for (const k of Array.from(new Set(toDelete))) {
    try {
      localStorage.removeItem(k);
    } catch {
      // ignore
    }
  }
}
