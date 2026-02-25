export const EXPECTED_SUPABASE_REFS = ["bqlejluaicankgomrizi"] as const;

function tryParseSupabaseRef(url: string | null | undefined): string | null {
  const raw = String(url || "").trim();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    const host = u.hostname || "";
    const ref = host.split(".")[0] || "";
    return ref || null;
  } catch {
    return null;
  }
}

export type BackendInfo = {
  supabaseUrl: string | null;
  supabaseRef: string | null;
  mode: string;
  appVersion: string | null;
  appCommit: string | null;
};

export function getBackendInfo(): BackendInfo {
  const supabaseUrl = (import.meta as any)?.env?.VITE_SUPABASE_URL
    ? String((import.meta as any).env.VITE_SUPABASE_URL)
    : null;

  const supabaseRef = tryParseSupabaseRef(supabaseUrl);
  const mode = String((import.meta as any)?.env?.MODE || "");

  const v = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "";
  const c = typeof __APP_COMMIT__ === "string" ? __APP_COMMIT__ : "";
  const appVersion = v.trim() ? v.trim() : null;
  const appCommit = c.trim() ? c.trim() : null;

  return {
    supabaseUrl,
    supabaseRef,
    mode,
    appVersion,
    appCommit,
  };
}
