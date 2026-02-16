import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { corsHeaders, json } from "../_shared/cors.ts";
import { hashPassword, validatePassword } from "../_shared/password.ts";
import {
  getBearerToken,
  getSupabaseEnv,
  isClearlyNotAUserJwt,
  supabaseAdminClient,
  supabaseAuthClient,
} from "../_shared/supabase.ts";

function sanitizeUsername(raw: string) {
  return String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "");
}

type CallerRow = {
  role: string | null;
  active: boolean | null;
  business_id: string | null;
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });

  try {
    const env = getSupabaseEnv();
    const jwt = getBearerToken(req);

    // Reject anon-key auth (and service key)
    if (!jwt || isClearlyNotAUserJwt(jwt, env)) {
      return json(401, { error: "Missing or invalid user session" });
    }

    // Verify the token against Supabase Auth
    const userClient = supabaseAuthClient(env, jwt);
    const {
      data: { user },
      error: userErr,
    } = await userClient.auth.getUser();

    if (userErr || !user) return json(401, { error: "Invalid user session" });

    const adminClient = supabaseAdminClient(env);

    // Caller profile (role + tenant scope)
    const { data: caller, error: callerErr } = await adminClient
      .from("profiles")
      .select("role, active, business_id")
      .eq("id", user.id)
      .maybeSingle();

    if (callerErr) return json(500, { error: "Failed to check caller role" });
    if (!caller || caller.active === false) return json(403, { error: "Account disabled" });

    const callerRow = caller as CallerRow;
    const isPlatformAdmin = callerRow.role === "platform_admin";
    const isBusinessAdmin = callerRow.role === "admin";

    if (!isPlatformAdmin && !isBusinessAdmin) return json(403, { error: "Admins only" });

    const body = await req.json().catch(() => ({} as any));

    const username = sanitizeUsername(body?.username);
    const full_name = String(body?.full_name || "").trim();

    const requestedRole = String(body?.role || "cashier").trim().toLowerCase();
    const role =
      requestedRole === "platform_admin"
        ? "platform_admin"
        : requestedRole === "admin"
        ? "admin"
        : "cashier";

    const permissions = body?.permissions && typeof body.permissions === "object" ? body.permissions : {};

    const password = String(body?.password || "");
    const passRes = validatePassword(password);

    if (!username) return json(400, { error: "Username required" });
    if (username.length < 3) return json(400, { error: "Username must be 3+ characters" });
    if (!full_name) return json(400, { error: "Full name required" });
    if (!passRes.ok) return json(400, { error: passRes.reason });

    let business_id: string | null = null;

    // Platform admin accounts: only platform admins can create them, and they are not tied to a business.
    if (role === "platform_admin") {
      if (!isPlatformAdmin) return json(403, { error: "Platform admins only" });
      business_id = null;
    } else {
      // Business staff accounts
      if (isPlatformAdmin) {
        business_id = String(body?.business_id || "").trim() || null;
        if (!business_id) return json(400, { error: "Missing business_id" });
      } else {
        business_id = callerRow.business_id;
        if (!business_id) {
          return json(400, {
            error: "Caller has no business_id. Ask BinanceXI POS admin to fix your account.",
          });
        }
      }
    }

    // Synthetic email (internal-only; no real mailbox needed)
    const email = `${username}@binancexi-pos.app`;

    // Create Auth user
    const { data: created, error: createErr } = await adminClient.auth.admin.createUser({
      email,
      password: passRes.password,
      email_confirm: true,
      user_metadata: { full_name },
    });

    if (createErr || !created.user) {
      return json(400, { error: createErr?.message ?? "User creation failed" });
    }

    // Create/update profile
    const { error: profileErr } = await adminClient.from("profiles").upsert(
      {
        id: created.user.id,
        username,
        full_name,
        role,
        permissions,
        active: true,
        business_id,
      },
      { onConflict: "id" }
    );

    if (profileErr) {
      return json(400, { error: profileErr.message });
    }

    // Store hashed PASSWORD in profile_secrets (offline-first login)
    const passHash = await hashPassword(passRes.password);
    const { error: passErr } = await adminClient.from("profile_secrets").upsert({
      id: created.user.id,
      ...passHash,
      updated_at: new Date().toISOString(),
    });

    if (passErr) {
      return json(500, {
        error: "Password storage failed",
        details: passErr.message,
      });
    }

    // Best-effort: clear legacy pin_code if column exists
    await adminClient.from("profiles").update({ pin_code: null as any }).eq("id", created.user.id);

    return json(200, { success: true });
  } catch (e: any) {
    return json(500, { error: "Unhandled error", details: e?.message || String(e) });
  }
});

