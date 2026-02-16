import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { corsHeaders, json } from "../_shared/cors.ts";
import {
  getBearerToken,
  getSupabaseEnv,
  isClearlyNotAUserJwt,
  supabaseAdminClient,
  supabaseAuthClient,
} from "../_shared/supabase.ts";

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });

  try {
    const env = getSupabaseEnv();
    const jwt = getBearerToken(req);

    // ✅ Reject anon-key auth (and service key)
    if (!jwt || isClearlyNotAUserJwt(jwt, env)) {
      return json(401, { error: "Missing or invalid user session" });
    }

    // ✅ Verify the token against Supabase Auth
    const userClient = supabaseAuthClient(env, jwt);
    const {
      data: { user },
      error: userErr,
    } = await userClient.auth.getUser();

    if (userErr || !user) return json(401, { error: "Invalid user session" });

    // ✅ Admin check (role stored in profiles)
    const admin = supabaseAdminClient(env);
    const { data: caller, error: callerErr } = await admin
      .from("profiles")
      .select("role, active, business_id")
      .eq("id", user.id)
      .maybeSingle();

    if (callerErr) return json(500, { error: "Failed to check caller role" });
    if (!caller || caller.active === false) return json(403, { error: "Account disabled" });

    const callerRole = String((caller as any)?.role || "");
    const isPlatformAdmin = callerRole === "platform_admin";
    const isBusinessAdmin = callerRole === "admin";

    if (!isPlatformAdmin && !isBusinessAdmin) return json(403, { error: "Admins only" });

    const body = await req.json().catch(() => ({} as any));
    const user_id = String(body?.user_id || "").trim();
    if (!user_id) return json(400, { error: "Missing user_id" });
    if (user_id === user.id) return json(400, { error: "You cannot delete your own account" });

    // Business admins can only manage users inside their business.
    if (!isPlatformAdmin) {
      const callerBusinessId = String((caller as any)?.business_id || "").trim();
      if (!callerBusinessId) {
        return json(400, {
          error: "Caller has no business_id. Ask BinanceXI POS admin to fix your account.",
        });
      }

      const { data: target, error: targetErr } = await admin
        .from("profiles")
        .select("id, role, business_id")
        .eq("id", user_id)
        .maybeSingle();

      if (targetErr) return json(500, { error: "Failed to load target user profile" });
      if (!target) return json(404, { error: "Target user profile not found" });
      if (String((target as any)?.role || "") === "platform_admin") {
        return json(403, { error: "Not allowed" });
      }
      if (String((target as any)?.business_id || "") !== callerBusinessId) {
        return json(403, { error: "Not allowed" });
      }
    }

    const { error: delErr } = await admin.auth.admin.deleteUser(user_id);
    if (delErr) return json(400, { error: delErr.message });

    // Best-effort cleanup (may fail if FK constraints exist)
    await admin.from("profile_secrets").delete().eq("id", user_id);
    await admin.from("profiles").delete().eq("id", user_id);

    return json(200, { success: true });
  } catch (e: any) {
    return json(500, { error: "Unhandled error", details: e?.message || String(e) });
  }
});
