import { createClient } from "@supabase/supabase-js";
import crypto from "node:crypto";

function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name}`);
  return v;
}

function clampInt(n, min, max) {
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function hashPassword(password, opts = {}) {
  const iterations = clampInt(opts.iterations ?? 210_000, 120_000, 800_000);
  const salt = crypto.randomBytes(16);
  const derived = crypto.pbkdf2Sync(String(password), salt, iterations, 32, "sha256");

  return {
    password_salt: salt.toString("base64"),
    password_hash: derived.toString("base64"),
    password_iter: iterations,
    password_kdf: "pbkdf2_sha256",
  };
}

async function findUserByEmail(admin, email) {
  const target = String(email || "").trim().toLowerCase();
  if (!target) return null;

  let page = 1;
  const perPage = 200;

  while (true) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage });
    if (error) throw error;

    const users = data?.users || [];
    const hit = users.find((u) => String(u?.email || "").trim().toLowerCase() === target);
    if (hit) return hit;

    if (users.length < perPage) break;
    page += 1;
  }

  return null;
}

async function findProfileByUsername(admin, username) {
  const u = String(username || "").trim().toLowerCase();
  if (!u) return null;

  const { data, error } = await admin
    .from("profiles")
    .select("id, username, full_name, role, active, business_id")
    .eq("username", u)
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

async function main() {
  const url = process.env.SUPABASE_URL || process.env.PROJECT_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SERVICE_ROLE_KEY;

  if (!url) throw new Error("Missing SUPABASE_URL/PROJECT_URL");
  if (!serviceKey) throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY/SERVICE_ROLE_KEY");

  const username = String(process.env.ADMIN_USERNAME || "tendainashe").trim().toLowerCase();
  const password = mustEnv("ADMIN_PASSWORD");
  const fullName = String(process.env.ADMIN_FULL_NAME || "Platform Admin").trim();
  const oldUsernameRaw = process.env.ADMIN_OLD_USERNAME;
  const oldUsername = oldUsernameRaw ? String(oldUsernameRaw).trim().toLowerCase() : "";

  const email = `${username}@binancexi-pos.app`;

  const admin = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });

  // Rename flow (keep the same auth user id, change profile username + reset password)
  if (oldUsername && oldUsername !== username) {
    const existing = await findProfileByUsername(admin, oldUsername);
    if (!existing?.id) {
      throw new Error(`Old admin username not found: ${oldUsername}`);
    }

    const conflict = await findProfileByUsername(admin, username);
    if (conflict?.id && conflict.id !== existing.id) {
      throw new Error(`Username already taken: ${username}`);
    }

    const userId = existing.id;

    const { error: profErr } = await admin
      .from("profiles")
      .update({
        username,
        full_name: fullName,
        role: "platform_admin",
        permissions: {},
        active: true,
        business_id: null,
      })
      .eq("id", userId);
    if (profErr) throw new Error(profErr.message);

    // Keep offline-first password hash in sync
    const hashed = hashPassword(password);
    const { error: secErr } = await admin.from("profile_secrets").upsert({
      id: userId,
      ...hashed,
      updated_at: new Date().toISOString(),
    });
    if (secErr) throw new Error(secErr.message);

    // Keep Supabase Auth password in sync
    const { error: authErr } = await admin.auth.admin.updateUserById(userId, {
      password,
      user_metadata: { full_name: fullName },
    });
    if (authErr) throw new Error(authErr.message);

    console.log(`Platform admin renamed: ${oldUsername} -> ${username} (${userId})`);
    return;
  }

  let userId = null;
  let createdNew = false;

  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: fullName },
  });
  if (!createErr && created?.user?.id) {
    userId = created.user.id;
    createdNew = true;
  } else {
    const msg = String(createErr?.message || "");
    // If the user already exists, treat this script as a password reset / metadata update.
    if (msg.toLowerCase().includes("already") || msg.toLowerCase().includes("registered")) {
      const existing = await findUserByEmail(admin, email);
      if (!existing?.id) throw new Error("Platform admin exists but could not be found by email");
      userId = existing.id;

      const { error: updateErr } = await admin.auth.admin.updateUserById(userId, {
        password,
        email_confirm: true,
        user_metadata: { full_name: fullName },
      });
      if (updateErr) throw updateErr;
    } else {
      throw new Error(createErr?.message || "Auth user creation failed");
    }
  }

  if (!userId) throw new Error("Missing admin user id");

  const { error: profErr } = await admin.from("profiles").upsert(
    {
      id: userId,
      username,
      full_name: fullName,
      role: "platform_admin",
      permissions: {},
      active: true,
      business_id: null,
    },
    { onConflict: "id" }
  );
  if (profErr) throw new Error(profErr.message);

  // Keep offline-first password hash in sync
  const hashed = hashPassword(password);
  const { error: secErr } = await admin.from("profile_secrets").upsert({
    id: userId,
    ...hashed,
    updated_at: new Date().toISOString(),
  });
  if (secErr) throw new Error(secErr.message);

  console.log(`${createdNew ? "Platform admin created" : "Platform admin updated"}: ${email} (${userId})`);
}

main().catch((e) => {
  console.error(e?.message || String(e));
  process.exit(1);
});
