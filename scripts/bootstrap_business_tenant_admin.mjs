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

function sanitizeUsername(raw) {
  return String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "");
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

async function findBusinessByName(admin, name) {
  const n = String(name || "").trim();
  if (!n) return null;

  const { data, error } = await admin
    .from("businesses")
    .select("id, name, status, created_at")
    .ilike("name", n)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

async function ensureBusiness(admin, name) {
  const existing = await findBusinessByName(admin, name);
  if (existing?.id) return { business: existing, created: false };

  const { data, error } = await admin
    .from("businesses")
    .insert({ name: String(name).trim(), status: "active" })
    .select("id, name, status, created_at")
    .single();
  if (error) throw error;
  return { business: data, created: true };
}

async function ensureBillingUnlocked(admin, businessId) {
  const future = new Date();
  future.setMonth(future.getMonth() + 1);

  const { error } = await admin.from("business_billing").upsert(
    {
      business_id: businessId,
      currency: "USD",
      grace_days: 7,
      locked_override: false,
      paid_through: future.toISOString(),
    },
    { onConflict: "business_id" }
  );
  if (error) throw error;
}

async function main() {
  const url = process.env.SUPABASE_URL || process.env.PROJECT_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SERVICE_ROLE_KEY;

  if (!url) throw new Error("Missing SUPABASE_URL/PROJECT_URL");
  if (!serviceKey) throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY/SERVICE_ROLE_KEY");

  const businessName = mustEnv("BUSINESS_NAME").trim();
  const adminUsername = sanitizeUsername(mustEnv("ADMIN_USERNAME"));
  const adminPassword = mustEnv("ADMIN_PASSWORD");
  const adminFullName = String(process.env.ADMIN_FULL_NAME || adminUsername).trim() || adminUsername;

  if (!businessName) throw new Error("BUSINESS_NAME is empty");
  if (!adminUsername || adminUsername.length < 3) throw new Error("ADMIN_USERNAME must be 3+ chars");
  if (String(adminPassword).length < 6) throw new Error("ADMIN_PASSWORD must be at least 6 chars");

  const email = `${adminUsername}@binancexi-pos.app`;

  const admin = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });

  const { business, created: businessCreated } = await ensureBusiness(admin, businessName);
  const businessId = String(business.id);

  await ensureBillingUnlocked(admin, businessId);

  let authUserId = null;
  let authCreated = false;
  const { data: createdUser, error: createErr } = await admin.auth.admin.createUser({
    email,
    password: adminPassword,
    email_confirm: true,
    user_metadata: { full_name: adminFullName },
  });

  if (!createErr && createdUser?.user?.id) {
    authUserId = createdUser.user.id;
    authCreated = true;
  } else {
    const msg = String(createErr?.message || "");
    if (msg.toLowerCase().includes("already") || msg.toLowerCase().includes("registered")) {
      const existing = await findUserByEmail(admin, email);
      if (!existing?.id) throw new Error("User exists but could not be found");
      authUserId = existing.id;

      const { error: updateErr } = await admin.auth.admin.updateUserById(authUserId, {
        password: adminPassword,
        email_confirm: true,
        user_metadata: { full_name: adminFullName },
      });
      if (updateErr) throw updateErr;
    } else {
      throw createErr || new Error("Failed to create auth user");
    }
  }

  if (!authUserId) throw new Error("Missing auth user id");

  const adminPermissions = {
    allowRefunds: true,
    allowVoid: true,
    allowPriceEdit: true,
    allowDiscount: true,
    allowServiceBookings: true,
    allowReports: true,
    allowInventory: true,
    allowSettings: true,
    allowEditReceipt: true,
  };

  const { error: profileErr } = await admin.from("profiles").upsert(
    {
      id: authUserId,
      username: adminUsername,
      full_name: adminFullName,
      role: "admin",
      permissions: adminPermissions,
      active: true,
      business_id: businessId,
    },
    { onConflict: "id" }
  );
  if (profileErr) throw profileErr;

  const hashed = hashPassword(adminPassword);
  const { error: secErr } = await admin.from("profile_secrets").upsert({
    id: authUserId,
    ...hashed,
    updated_at: new Date().toISOString(),
  });
  if (secErr) throw secErr;

  console.log(
    JSON.stringify(
      {
        ok: true,
        business: {
          id: businessId,
          name: businessName,
          created: businessCreated,
        },
        admin: {
          id: authUserId,
          username: adminUsername,
          full_name: adminFullName,
          email,
          created: authCreated,
        },
      },
      null,
      2
    )
  );
}

main().catch((e) => {
  console.error(e?.message || String(e));
  process.exit(1);
});
