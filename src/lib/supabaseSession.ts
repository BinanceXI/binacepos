import { supabase } from "@/lib/supabase";
import type { Session } from "@supabase/supabase-js";

export type EnsureSupabaseSessionResult =
  | { ok: true; session: Session }
  | { ok: false; error: string };

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
    msg.includes("permission denied")
  );
}

// Best-effort: ensure we have a valid Supabase session for RLS-protected writes.
export async function ensureSupabaseSession(): Promise<EnsureSupabaseSessionResult> {
  try {
    const { data, error } = await supabase.auth.getSession();
    if (error) return { ok: false, error: error.message || "Failed to get session" };

    if (data.session) {
      // If the token is close to expiring, refresh once to avoid 401s during sync bursts.
      if (!sessionExpiresSoon(data.session, 60_000)) return { ok: true, session: data.session };

      const { data: refreshed, error: refreshErr } = await supabase.auth.refreshSession();
      if (refreshErr) return { ok: false, error: refreshErr.message || "Failed to refresh session" };
      if (refreshed.session) return { ok: true, session: refreshed.session };
      return { ok: false, error: "No active session" };
    }

    // No session found: try refresh (works if a refresh token is persisted).
    const { data: refreshed, error: refreshErr } = await supabase.auth.refreshSession();
    if (refreshErr) return { ok: false, error: refreshErr.message || "Failed to refresh session" };
    if (refreshed.session) return { ok: true, session: refreshed.session };

    return { ok: false, error: "No active session" };
  } catch (e: any) {
    return { ok: false, error: e?.message || "Failed to ensure session" };
  }
}

export async function requireAuthedSessionOrBlockSync(): Promise<RequireAuthedSessionOrBlockSyncResult> {
  const sessionRes = await ensureSupabaseSession();
  if (!sessionRes.ok) {
    return { ok: false, reason: "AUTH_REQUIRED", message: SYNC_PAUSED_AUTH_MESSAGE };
  }

  const userId = String(sessionRes.session?.user?.id || "").trim();
  if (!userId) {
    return { ok: false, reason: "AUTH_REQUIRED", message: SYNC_PAUSED_AUTH_MESSAGE };
  }

  return { ok: true, session: sessionRes.session, userId };
}
