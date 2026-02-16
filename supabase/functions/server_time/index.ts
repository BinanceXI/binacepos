import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { corsHeaders, json } from "../_shared/cors.ts";
import { getSupabaseEnv, supabaseAdminClient } from "../_shared/supabase.ts";

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "GET" && req.method !== "POST") return json(405, { error: "Method not allowed" });

  try {
    const env = getSupabaseEnv();
    const admin = supabaseAdminClient(env);

    // Prefer DB time (authoritative).
    const { data, error } = await admin.rpc("server_time");
    if (error) {
      return json(500, { error: "server_time rpc failed", details: error.message });
    }

    const unix_ms = Number((data as any)?.unix_ms ?? NaN);
    const iso_utc = String((data as any)?.iso_utc ?? "");

    if (!Number.isFinite(unix_ms) || !iso_utc) {
      // Fallback: edge runtime time (still safer than client).
      return json(200, { unix_ms: Date.now(), iso_utc: new Date().toISOString() });
    }

    return json(200, { unix_ms, iso_utc });
  } catch (e: any) {
    return json(500, { error: "Unhandled error", details: e?.message || String(e) });
  }
});

