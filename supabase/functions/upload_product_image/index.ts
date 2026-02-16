import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsHeaders, json } from "../_shared/cors.ts";
import {
  getBearerToken,
  getSupabaseEnv,
  isClearlyNotAUserJwt,
  supabaseAdminClient,
  supabaseAuthClient,
} from "../_shared/supabase.ts";

type ProfileRow = {
  role?: string | null;
  active?: boolean | null;
  permissions?: any;
};

Deno.serve(async (req) => {
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

    // ✅ Authorize: admin or inventory permission
    const admin = supabaseAdminClient(env);
    const { data: profile, error: profErr } = await admin
      .from("profiles")
      .select("role, active, permissions")
      .eq("id", user.id)
      .maybeSingle();

    if (profErr) return json(500, { error: "Failed to check permissions" });
    if (!profile || (profile as ProfileRow).active === false) {
      return json(403, { error: "Account disabled" });
    }

    const role = String((profile as ProfileRow).role || "");
    const perms = (profile as ProfileRow).permissions || {};
    const canInventory = role === "admin" || !!perms?.allowInventory;
    if (!canInventory) return json(403, { error: "Not allowed" });

    const body = await req.json().catch(() => ({} as any));
    const fileName = String(body?.fileName || "").trim();
    const contentType = String(body?.contentType || "").trim() || "image/png";
    const base64 = String(body?.base64 || "");

    if (!fileName || !base64) {
      return json(400, { error: "Missing fileName or base64" });
    }

    // Guard rails: keep payload sizes reasonable
    if (base64.length > 4_500_000) {
      return json(413, { error: "Image too large" });
    }

    // Decode base64 -> bytes
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));

    // Safe filename
    const cleanName = fileName.replace(/[^\w.-]/g, "_");
    const path = `products/${crypto.randomUUID()}-${cleanName}`;

    const { error: uploadError } = await admin.storage.from("product-images").upload(path, bytes, {
      contentType,
      upsert: true,
    });

    if (uploadError) {
      return json(500, { error: "Storage upload failed", details: uploadError.message });
    }

    const { data } = admin.storage.from("product-images").getPublicUrl(path);
    return json(200, { publicUrl: data.publicUrl, path });
  } catch (e: any) {
    return json(500, { error: "Unhandled error", details: e?.message || String(e) });
  }
});
