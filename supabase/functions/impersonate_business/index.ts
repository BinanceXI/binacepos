import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { corsHeaders, json } from "../_shared/cors.ts";
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

function clampLen(s: string, max: number) {
  const str = String(s || "");
  return str.length > max ? str.slice(0, max) : str;
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

    if (!jwt || isClearlyNotAUserJwt(jwt, env)) {
      return json(401, { error: "Missing or invalid user session" });
    }

    const userClient = supabaseAuthClient(env, jwt);
    const {
      data: { user },
      error: userErr,
    } = await userClient.auth.getUser();

    if (userErr || !user) return json(401, { error: "Invalid user session" });

    const admin = supabaseAdminClient(env);

    const { data: caller, error: callerErr } = await admin
      .from("profiles")
      .select("role, active, business_id")
      .eq("id", user.id)
      .maybeSingle();

    if (callerErr) return json(500, { error: "Failed to check caller role" });
    if (!caller || caller.active === false) return json(403, { error: "Account disabled" });

    const callerRow = caller as CallerRow;
    if (callerRow.role !== "platform_admin") return json(403, { error: "Platform admins only" });

    const body = await req.json().catch(() => ({} as any));
    const business_id = String(body?.business_id || "").trim();
    const requestedRole = String(body?.role || "admin").trim().toLowerCase();
    const role = requestedRole === "cashier" ? "cashier" : "admin";
    const reason = String(body?.reason || "").trim();

    if (!business_id) return json(400, { error: "Missing business_id" });
    if (!reason || reason.length < 3) return json(400, { error: "Reason is required" });

    // Find existing support user for this business+role
    const { data: existing, error: existingErr } = await admin
      .from("profiles")
      .select("id, username, full_name, role, permissions, active, business_id, is_support")
      .eq("business_id", business_id)
      .eq("is_support", true)
      .eq("role", role)
      .limit(1)
      .maybeSingle();

    if (existingErr) return json(500, { error: "Support user lookup failed", details: existingErr.message });

    let supportUserId: string | null = existing?.id ? String(existing.id) : null;
    let supportEmail: string | null = null;
    let supportProfile: any = existing || null;

    if (!supportUserId) {
      // Deterministic-enough identity so we don't create many accounts.
      const shortBiz = business_id.replace(/-/g, "").slice(0, 8);
      const username = sanitizeUsername(`support_${role}_${shortBiz}`);
      const full_name = role === "admin" ? "Support (Admin)" : "Support (Cashier)";
      const email = `${username}@binancexi-pos.app`;
      supportEmail = email;

      // Random password (not used directly; we mint a session via magiclink token_hash).
      const password = crypto.randomUUID() + crypto.randomUUID();

      const { data: created, error: createErr } = await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { full_name },
      });

      if (createErr || !created.user) {
        return json(400, { error: createErr?.message ?? "User creation failed" });
      }

      supportUserId = created.user.id;

      const perms =
        role === "admin"
          ? {
              allowRefunds: true,
              allowVoid: true,
              allowPriceEdit: true,
              allowDiscount: true,
              allowReports: true,
              allowInventory: true,
              allowSettings: true,
              allowEditReceipt: true,
            }
          : {
              allowRefunds: false,
              allowVoid: false,
              allowPriceEdit: false,
              allowDiscount: true,
              allowReports: false,
              allowInventory: false,
              allowSettings: false,
              allowEditReceipt: false,
            };

      const { error: profErr } = await admin.from("profiles").upsert(
        {
          id: supportUserId,
          username,
          full_name,
          role,
          permissions: perms,
          active: true,
          business_id,
          is_support: true,
        },
        { onConflict: "id" }
      );

      if (profErr) return json(500, { error: "Failed to provision support profile", details: profErr.message });

      supportProfile = {
        id: supportUserId,
        username,
        full_name,
        role,
        permissions: perms,
        active: true,
        business_id,
        is_support: true,
      };
    } else {
      // Resolve real email for existing support user.
      try {
        const { data: authUser } = await admin.auth.admin.getUserById(supportUserId);
        supportEmail = authUser?.user?.email ? String(authUser.user.email) : null;
      } catch {
        supportEmail = null;
      }
    }

    if (!supportUserId) return json(500, { error: "Support user id missing" });

    // Fallback if we couldn't resolve email (shouldn't happen for our synthetic mapping).
    if (!supportEmail) {
      const uname = sanitizeUsername(String((supportProfile as any)?.username || ""));
      supportEmail = uname ? `${uname}@binancexi-pos.app` : null;
    }

    if (!supportEmail) return json(500, { error: "Support email missing" });

    // Create magiclink hash for client to mint a real session.
    const { data: link, error: linkErr } = await admin.auth.admin.generateLink({
      type: "magiclink",
      email: supportEmail,
    });

    if (linkErr || !link?.properties?.hashed_token) {
      return json(500, {
        error: "Failed to create session token",
        details: linkErr?.message || "missing hashed_token",
      });
    }

    // Audit record
    const { data: audit, error: auditErr } = await admin
      .from("impersonation_audit")
      .insert({
        platform_admin_id: user.id,
        business_id,
        support_user_id: supportUserId,
        reason: clampLen(reason, 500),
      })
      .select("id")
      .single();

    if (auditErr) {
      return json(500, { error: "Failed to write audit log", details: auditErr.message });
    }

    return json(200, {
      ok: true,
      audit_id: String((audit as any)?.id || ""),
      token_hash: link.properties.hashed_token,
      type: "magiclink",
      support_profile: supportProfile || { id: supportUserId, business_id, role, is_support: true },
    });
  } catch (e: any) {
    return json(500, { error: "Unhandled error", details: e?.message || String(e) });
  }
});
