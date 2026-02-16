import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

export function getSupabaseEnv() {
  const url = Deno.env.get("SUPABASE_URL") || Deno.env.get("PROJECT_URL") || "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("ANON_KEY") || "";
  const serviceRoleKey =
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SERVICE_ROLE_KEY") || "";

  if (!url) throw new Error("Missing SUPABASE_URL/PROJECT_URL");
  if (!serviceRoleKey) throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY/SERVICE_ROLE_KEY");

  return { url, anonKey, serviceRoleKey };
}

export function getBearerToken(req: Request) {
  const raw = req.headers.get("Authorization") || "";
  const m = raw.match(/^Bearer\s+(.+)$/i);
  const token = (m?.[1] || "").trim();
  return token || null;
}

function decodeJwtPayload(token: string) {
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = payload + "=".repeat((4 - (payload.length % 4)) % 4);
    const json = atob(padded);
    return JSON.parse(json) as any;
  } catch {
    return null;
  }
}

export function isClearlyNotAUserJwt(token: string, env: { anonKey: string; serviceRoleKey: string }) {
  if (!token) return true;
  if (token === env.anonKey) return true;
  if (token === env.serviceRoleKey) return true;

  const payload = decodeJwtPayload(token);
  if (!payload) return true;

  // Supabase user access tokens include `sub` (user id) and role is typically "authenticated".
  if (!payload.sub) return true;
  if (payload.role === "anon" || payload.role === "service_role") return true;

  return false;
}

export function supabaseAuthClient(env: { url: string; anonKey?: string; serviceRoleKey: string }, userJwt: string) {
  return createClient(env.url, env.anonKey || env.serviceRoleKey, {
    global: { headers: { Authorization: `Bearer ${userJwt}` } },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

export function supabaseAdminClient(env: { url: string; serviceRoleKey: string }) {
  return createClient(env.url, env.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}
