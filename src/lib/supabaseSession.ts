import { supabase } from "@/lib/supabase";
import type { Session } from "@supabase/supabase-js";

export type EnsureSupabaseSessionResult =
  | { ok: true; session: Session }
  | { ok: false; error: string };

export type EnsureSupabaseSessionOptions = {
  forceRefresh?: boolean;
  verifyUser?: boolean;
  refreshLeewayMs?: number;
};

export type SyncBlockedReason = "AUTH_REQUIRED";

export type RequireAuthedSessionOrBlockSyncResult =
  | { ok: true; session: Session; userId: string }
  | { ok: false; reason: SyncBlockedReason; message: string };

export const SYNC_PAUSED_AUTH_MESSAGE = "Sync paused — sign in online to resume.";

function sessionExpiresSoon(session: Session, withinMs: number) {
  const exp = session.expires_at ? session.expires_at * 1000 : null;
  if (!exp) return false;
  return exp - Date.now() <= withinMs;
}

export function isLikelyAuthError(err: any) {
  const status = (err as any)?.status;
  if (status === 401 || status === 403) return true;

  const code = String((err as any)?.code || "");
  if (code === "PGRST301") return true; // "JWT expired" / auth-related in PostgREST

  const msg = String((err as any)?.message || "").toLowerCase();
  return (
    msg.includes("jwt") ||
    msg.includes("unauthorized") ||
    msg.includes("not authorized") ||
    msg.includes("permission denied") ||
    msg.includes("missing or invalid user session") ||
    msg.includes("invalid user session")
  );
}

function messageFromAuthError(err: any, fallback: string) {
  return String(err?.message || "").trim() || fallback;
}

async function verifyActiveUserFromSession() {
  const { data, error } = await supabase.auth.getUser();
  if (error || !data?.user?.id) {
    return { ok: false as const, error: messageFromAuthError(error, "Invalid user session") };
  }
  return { ok: true as const };
}

// Best-effort: ensure we have a valid Supabase session for RLS-protected writes.
export async function ensureSupabaseSession(
  opts?: EnsureSupabaseSessionOptions
): Promise<EnsureSupabaseSessionResult> {
  try {
    const forceRefresh = !!opts?.forceRefresh;
    const verifyUser = opts?.verifyUser !== false;
    const refreshLeewayMs = Math.max(1, Number(opts?.refreshLeewayMs ?? 60_000));

    const { data, error } = await supabase.auth.getSession();
    if (error) return { ok: false, error: error.message || "Failed to get session" };

    let session = data.session || null;
    const needsRefresh =
      forceRefresh || !session || sessionExpiresSoon(session, refreshLeewayMs);

    if (needsRefresh) {
      const { data: refreshed, error: refreshErr } = await supabase.auth.refreshSession();
      if (refreshErr) return { ok: false, error: refreshErr.message || "Failed to refresh session" };
      session = refreshed.session || null;
    }

    if (!session) {
      return { ok: false, error: "No active session" };
    }

    if (!verifyUser) return { ok: true, session };

    // Verify token validity by reading the active auth user.
    const firstCheck = await verifyActiveUserFromSession();
    if (firstCheck.ok) return { ok: true, session };

    // Retry exactly once with a forced refresh for stale/invalid JWT scenarios.
    const { data: refreshed, error: refreshErr } = await supabase.auth.refreshSession();
    if (refreshErr) return { ok: false, error: refreshErr.message || firstCheck.error };
    if (!refreshed.session) return { ok: false, error: "No active session" };

    const secondCheck = await verifyActiveUserFromSession();
    if (!secondCheck.ok) return { ok: false, error: secondCheck.error };

    return { ok: true, session: refreshed.session };
  } catch (e: any) {
    return { ok: false, error: e?.message || "Failed to ensure session" };
  }
}

export async function requireAuthedSessionOrBlockSync(): Promise<RequireAuthedSessionOrBlockSyncResult> {
  const sessionRes = await ensureSupabaseSession({ verifyUser: true });
  if (!sessionRes.ok) {
    return { ok: false, reason: "AUTH_REQUIRED", message: SYNC_PAUSED_AUTH_MESSAGE };
  }

  const userId = String(sessionRes.session?.user?.id || "").trim();
  if (!userId) {
    return { ok: false, reason: "AUTH_REQUIRED", message: SYNC_PAUSED_AUTH_MESSAGE };
  }

  return { ok: true, session: sessionRes.session, userId };
}
