import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, json } from "../_shared/cors.ts";
import { hashPassword, validatePassword, verifyPassword } from "../_shared/password.ts";
import { getSupabaseEnv, supabaseAdminClient } from "../_shared/supabase.ts";

function sanitizeUsername(raw: string) {
  return String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "");
}

type ProfileRow = {
  id: string;
  username: string;
  full_name: string | null;
  role: "admin" | "cashier" | string | null;
  permissions: any;
  business_id: string | null;
  active: boolean | null;
};

type SecretRow = {
  password_salt: string | null;
  password_hash: string | null;
  password_iter: number | null;
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });

  try {
    const env = getSupabaseEnv();

    const body = await req.json().catch(() => ({} as any));
    const username = sanitizeUsername(body?.username);
    const passRes = validatePassword(body?.password);

    if (!username) return json(400, { error: "Username required" });
    if (!passRes.ok) return json(400, { error: passRes.reason });

    const admin = supabaseAdminClient(env);

    const { data: profile, error: profErr } = await admin
      .from("profiles")
      .select("id, username, full_name, role, permissions, active, business_id")
      .eq("username", username)
      .maybeSingle();

    if (profErr) return json(500, { error: "Profile lookup failed" });
    if (!profile) return json(401, { error: "Invalid credentials" });

    const p = profile as ProfileRow;
    if (p.active === false) return json(403, { error: "Account disabled" });

    // Resolve the Auth user's actual email (some projects may not use the synthetic username@binancexi-pos.app mapping)
    let authEmail = `${p.username}@binancexi-pos.app`;
    try {
      const { data: authUser, error: authUserErr } = await admin.auth.admin.getUserById(p.id);
      if (!authUserErr && authUser?.user?.email) authEmail = authUser.user.email;
    } catch {
      // ignore; fallback to synthetic email
    }

    let ok = false;

    // Prefer hashed passwords in profile_secrets
    const { data: secret, error: secErr } = await admin
      .from("profile_secrets")
      .select("password_salt, password_hash, password_iter")
      .eq("id", p.id)
      .maybeSingle();

    if (secErr) {
      return json(500, {
        error: "Password store not configured",
        details: secErr.message,
      });
    }

    const s = (secret as SecretRow | null) || null;
    if (s?.password_salt && s?.password_hash && s?.password_iter) {
      ok = await verifyPassword(passRes.password, {
        password_salt: s.password_salt,
        password_hash: s.password_hash,
        password_iter: s.password_iter,
      });
    } else {
      // Migration path: verify against Supabase Auth password (username-mapped email),
      // then store a PBKDF2 hash in profile_secrets for offline-first login.
      if (!env.anonKey) return json(401, { error: "Password not set yet. Ask an admin to set your password." });

      const publicClient = createClient(env.url, env.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      });

      const { data: signIn, error: signErr } = await publicClient.auth.signInWithPassword({
        email: authEmail,
        password: passRes.password,
      });
      if (signErr || !signIn?.user) return json(401, { error: "Invalid credentials" });

      ok = true;

      const hashed = await hashPassword(passRes.password);
      await admin.from("profile_secrets").upsert({
        id: p.id,
        ...hashed,
        updated_at: new Date().toISOString(),
      });
    }

    if (!ok) return json(401, { error: "Invalid credentials" });

    // ✅ Create a one-time magiclink token hash so the client can mint a real Supabase Auth session JWT
    const { data: link, error: linkErr } = await admin.auth.admin.generateLink({
      type: "magiclink",
      email: authEmail,
    });

    if (linkErr || !link?.properties?.hashed_token) {
      return json(500, {
        error: "Failed to create session token",
        details: linkErr?.message || "missing hashed_token",
      });
    }

    return json(200, {
      ok: true,
      user: {
        id: p.id,
        username: p.username,
        full_name: p.full_name,
        role: p.role,
        permissions: p.permissions || {},
        business_id: p.business_id,
        active: p.active,
      },
      token_hash: link.properties.hashed_token,
      type: "magiclink",
    });
  } catch (e: any) {
    return json(500, { error: "Unhandled error", details: e?.message || String(e) });
  }
});
