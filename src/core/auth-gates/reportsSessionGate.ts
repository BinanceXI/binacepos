import { ensureSupabaseSession } from "@/lib/supabaseSession";

export const REPORTS_OFFLINE_BANNER = "Offline mode: showing local data";

export type ReportsSessionGateResult =
  | { mode: "online"; banner: null }
  | { mode: "offline"; banner: string; reason: "offline" | "auth" };

export async function requireAuthedSessionOrOfflineBanner(args?: {
  isOnline?: boolean;
}): Promise<ReportsSessionGateResult> {
  const isOnline = args?.isOnline !== false;
  if (!isOnline) {
    return {
      mode: "offline",
      banner: REPORTS_OFFLINE_BANNER,
      reason: "offline",
    };
  }

  const session = await ensureSupabaseSession();
  if (!session.ok) {
    return {
      mode: "offline",
      banner: REPORTS_OFFLINE_BANNER,
      reason: "auth",
    };
  }

  return { mode: "online", banner: null };
}

