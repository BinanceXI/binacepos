import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { corsHeaders, json } from "../_shared/cors.ts";
import { hashPassword } from "../_shared/password.ts";
import { getSupabaseEnv, supabaseAdminClient } from "../_shared/supabase.ts";

function firstIpFromXff(xff: string) {
  return xff
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)[0] || null;
}

function getClientIp(req: Request) {
  // Prefer Cloudflare, then generic proxies.
  const cf = req.headers.get("cf-connecting-ip");
  if (cf) return cf.trim();
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return firstIpFromXff(xff);
  const real = req.headers.get("x-real-ip");
  if (real) return real.trim();
  return null;
}

async function sha256Hex(input: string) {
  const bytes = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function randomString(len: number, alphabet: string) {
  const out: string[] = [];
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  for (let i = 0; i < len; i++) out.push(alphabet[bytes[i] % alphabet.length]);
  return out.join("");
}

function sanitizeEmail(raw: unknown) {
  const s = String(raw || "").trim().toLowerCase();
  if (!s) return null;
  if (s.length > 254) return null;
  // Minimal check; we only store it as lead attribution.
  if (!s.includes("@") || !s.includes(".")) return null;
  return s;
}

function clampInt(n: number, min: number, max: number) {
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function intEnv(name: string, fallback: number) {
  const raw = String(Deno.env.get(name) || "").trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function parseAllowedHosts(raw: string | null) {
  const parts = String(raw || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length === 0) return null;

  const out = new Set<string>();
  for (const p of parts) {
    try {
      const u = p.includes("://") ? new URL(p) : new URL(`https://${p}`);
      if (u.host) out.add(u.host.toLowerCase());
    } catch {
      // ignore invalid entry
    }
  }

  return out.size > 0 ? out : null;
}

function getOriginHost(req: Request) {
  const origin = req.headers.get("origin");
  if (origin) {
    try {
      return new URL(origin).host.toLowerCase();
    } catch {
      return null;
    }
  }

  // Non-browser clients: fall back to Host.
  const host = req.headers.get("host");
  return host ? host.toLowerCase() : null;
}

async function verifyTurnstile(args: { token: string; ip?: string | null }) {
  const secret = String(Deno.env.get("TURNSTILE_SECRET_KEY") || "").trim();
  if (!secret) return { enabled: false as const, ok: true as const };

  const token = String(args.token || "").trim();
  if (!token) return { enabled: true as const, ok: false as const, reason: "Captcha required" };

  const params = new URLSearchParams();
  params.set("secret", secret);
  params.set("response", token);
  if (args.ip) params.set("remoteip", String(args.ip));

  const resp = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  const data = (await resp.json().catch(() => null)) as any;
  if (!resp.ok) return { enabled: true as const, ok: false as const, reason: "Captcha verification failed" };
  if (!data?.success) return { enabled: true as const, ok: false as const, reason: "Captcha verification failed" };

  return { enabled: true as const, ok: true as const };
}

async function cleanupExpiredDemoTenants(admin: ReturnType<typeof supabaseAdminClient>) {
  const nowIso = new Date().toISOString();

  const { data: sessions, error: sessErr } = await admin
    .from("demo_sessions")
    .select("id, business_id, user_id")
    .lte("expires_at", nowIso)
    .order("expires_at", { ascending: true })
    .limit(10);

  if (sessErr || !Array.isArray(sessions) || sessions.length === 0) return;

  for (const row of sessions as any[]) {
    const sessionId = String(row?.id || "").trim();
    const businessId = String(row?.business_id || "").trim();
    const userId = String(row?.user_id || "").trim();

    if (!sessionId || !businessId) continue;

    try {
      // Safety: only delete demo tenants.
      const { data: biz, error: bizErr } = await admin
        .from("businesses")
        .select("is_demo")
        .eq("id", businessId)
        .maybeSingle();

      if (bizErr) {
        // If the schema isn't migrated yet, do nothing (avoid risky deletes).
        continue;
      }

      if (!biz) {
        // Business already removed; drop the tracking row.
        await admin.from("demo_sessions").delete().eq("id", sessionId);
        continue;
      }

      if ((biz as any)?.is_demo !== true) {
        // Never touch non-demo businesses.
        continue;
      }

      // Delete tenant data (order matters due to FK constraints).
      await admin.from("orders").delete().eq("business_id", businessId);
      await admin.from("order_items").delete().eq("business_id", businessId);
      await admin.from("products").delete().eq("business_id", businessId);
      await admin.from("expenses").delete().eq("business_id", businessId);
      await admin.from("service_bookings").delete().eq("business_id", businessId);
      await admin.from("store_settings").delete().eq("business_id", businessId);
      await admin.from("app_feedback").delete().eq("business_id", businessId);
      await admin.from("business_devices").delete().eq("business_id", businessId);

      // Remove auth user (cascades profile row).
      if (userId) {
        await admin.auth.admin.deleteUser(userId).catch(() => void 0);
      }

      // Remove the business (billing/related rows cascade).
      await admin.from("businesses").delete().eq("id", businessId);

      // Remove tracking row (may already be gone if cascaded).
      await admin.from("demo_sessions").delete().eq("id", sessionId);
    } catch {
      // best-effort cleanup: continue
    }
  }
}

serve(async (req) => {
  const allowedHosts = parseAllowedHosts(Deno.env.get("DEMO_ALLOWED_ORIGINS") || null);
  const origin = req.headers.get("origin");
  const cors =
    origin && origin.trim()
      ? ({ ...corsHeaders, "Access-Control-Allow-Origin": origin.trim(), Vary: "Origin" } as Record<string, string>)
      : (corsHeaders as Record<string, string>);
  const demoEnabled = ["1", "true", "yes"].includes(
    String(Deno.env.get("ENABLE_LIVE_DEMO") || "").trim().toLowerCase()
  );

  if (!demoEnabled) {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    return json(403, { error: "Live demo is disabled" }, cors);
  }

  if (allowedHosts) {
    const originHost = getOriginHost(req);
    if (!originHost || !allowedHosts.has(originHost)) {
      if (req.method === "OPTIONS") return new Response(null, { status: 403 });
      return new Response(JSON.stringify({ error: "Forbidden" }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return json(405, { error: "Method not allowed" }, cors);

  const env = getSupabaseEnv();
  const admin = supabaseAdminClient(env);

  let createdBusinessId: string | null = null;
  let createdUserId: string | null = null;

  try {
    const body = await req.json().catch(() => ({} as any));
    const email = sanitizeEmail((body as any)?.email);

    const ipRaw = getClientIp(req);
    const ip = ipRaw || "unknown";

    // Optional: Turnstile captcha to keep demo available on shared networks.
    const captchaRes = await verifyTurnstile({ token: (body as any)?.turnstile_token, ip: ipRaw });
    if (captchaRes.enabled && !captchaRes.ok) {
      return json(400, { error: captchaRes.reason || "Captcha verification failed. Try again." }, cors);
    }

    const salt = String(Deno.env.get("DEMO_IP_HASH_SALT") || "").trim();
    if (!salt) return json(500, { error: "Server misconfigured (missing DEMO_IP_HASH_SALT)" }, cors);

    const ip_hash = await sha256Hex(`${salt}|${ip}`);

    const windowMinutes = clampInt(intEnv("DEMO_RATE_LIMIT_WINDOW_MINUTES", 60), 1, 24 * 60);
    const maxPerWindow = clampInt(intEnv("DEMO_RATE_LIMIT_MAX", 3), 1, 50);
    const maxPerWindowCaptcha = clampInt(intEnv("DEMO_RATE_LIMIT_MAX_TURNSTILE", 10), 1, 200);
    const allowBoost = captchaRes.enabled && captchaRes.ok;
    const effectiveMax = ipRaw
      ? allowBoost
        ? Math.max(maxPerWindow, maxPerWindowCaptcha)
        : maxPerWindow
      : Math.min(maxPerWindow, 1);

    const sinceIso = new Date(Date.now() - windowMinutes * 60 * 1000).toISOString();

    const { count, error: rateErr } = await admin
      .from("demo_sessions")
      .select("id", { count: "exact", head: true })
      .eq("ip_hash", ip_hash)
      .gte("created_at", sinceIso);

    if (rateErr) return json(500, { error: "Rate limit check failed" }, cors);
    if ((count || 0) >= effectiveMax) {
      return json(429, { error: "Too many demo sessions from this network. Try again later." }, cors);
    }

    // Opportunistic cleanup (bounded, best-effort).
    await cleanupExpiredDemoTenants(admin);

    const ttlHours = 1;
    const expires_at = new Date(Date.now() + ttlHours * 60 * 60 * 1000).toISOString();

    const shortId = randomString(6, "ABCDEFGHJKLMNPQRSTUVWXYZ23456789");
    const bizName = `Demo Business ${shortId}`;

    // Create demo business
    const { data: biz, error: bizErr } = await admin
      .from("businesses")
      .insert({ name: bizName, status: "active", plan_type: "business_system", is_demo: true } as any)
      .select("id")
      .single();

    if (bizErr || !biz?.id) return json(500, { error: "Failed to create demo business" }, cors);
    createdBusinessId = String((biz as any).id);

    // Ensure billing is active until demo expiry; max devices high to avoid friction.
    const { error: billErr } = await admin.from("business_billing").upsert(
      {
        business_id: createdBusinessId,
        grace_days: 0,
        paid_through: expires_at,
        locked_override: false,
        max_devices: 10,
        currency: "USD",
      } as any,
      { onConflict: "business_id" }
    );

    if (billErr) return json(500, { error: "Failed to initialize demo billing" }, cors);

    // Create demo admin user (retry a few times for uniqueness)
    const full_name = "Demo Admin";
    const password = randomString(
      18,
      "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#$%^&*"
    );

    let username: string | null = null;
    for (let attempt = 0; attempt < 6; attempt++) {
      const candidate = `demo_${randomString(8, "abcdefghijklmnopqrstuvwxyz0123456789")}`;
      const authEmail = `${candidate}@binancexi-pos.app`;

      const { data: created, error: createErr } = await admin.auth.admin.createUser({
        email: authEmail,
        password,
        email_confirm: true,
        user_metadata: { full_name },
      });

      if (createErr) {
        const msg = String(createErr.message || "").toLowerCase();
        // If random collision happens, just retry.
        if (msg.includes("already") || msg.includes("registered") || msg.includes("exists")) continue;
        return json(500, { error: "Failed to create demo user", details: createErr.message }, cors);
      }

      if (!created.user?.id) return json(500, { error: "Failed to create demo user" }, cors);

      username = candidate;
      createdUserId = String(created.user.id);
      break;
    }

    if (!createdUserId || !username) return json(500, { error: "Failed to provision demo user" }, cors);

    const { error: profileErr } = await admin.from("profiles").upsert(
      {
        id: createdUserId,
        username,
        full_name,
        role: "admin",
        permissions: {},
        active: true,
        business_id: createdBusinessId,
        is_support: false,
      } as any,
      { onConflict: "id" }
    );

    if (profileErr) return json(500, { error: "Failed to create demo profile" }, cors);

    const passHash = await hashPassword(password);
    const { error: passErr } = await admin.from("profile_secrets").upsert(
      {
        id: createdUserId,
        ...passHash,
        updated_at: new Date().toISOString(),
      } as any,
      { onConflict: "id" }
    );

    if (passErr) return json(500, { error: "Password storage failed" }, cors);

    // Seed store settings
    await admin.from("store_settings").upsert(
      {
        business_id: createdBusinessId,
        id: "default",
        business_name: bizName,
        currency: "USD",
        show_qr_code: true,
        qr_code_data: null,
        footer_message: "Thanks for trying BinanceXI POS (Demo).",
        tax_included: false,
        tax_rate: 0,
        low_stock_alerts: true,
        low_stock_threshold: 5,
      } as any,
      { onConflict: "business_id,id" }
    );

    // Seed products
    const seedProducts = [
      {
        name: "Coca Cola 500ml",
        category: "Beverages",
        type: "good",
        sku: "BEV-COC-500",
        barcode: "6001065507508",
        shortcut_code: "101",
        price: 1.5,
        cost_price: 1.0,
        stock_quantity: 30,
      },
      {
        name: "Water 1L",
        category: "Beverages",
        type: "good",
        sku: "BEV-WAT-1L",
        barcode: "6009601262342",
        shortcut_code: "102",
        price: 1.0,
        cost_price: 0.6,
        stock_quantity: 40,
      },
      {
        name: "Orange Juice",
        category: "Beverages",
        type: "good",
        sku: "BEV-JUI-ORG",
        barcode: "5010478012345",
        shortcut_code: "103",
        price: 2.0,
        cost_price: 1.2,
        stock_quantity: 18,
      },
      {
        name: "Potato Chips",
        category: "Snacks",
        type: "good",
        sku: "SNK-CHP-001",
        barcode: "6009689123456",
        shortcut_code: "201",
        price: 1.2,
        cost_price: 0.7,
        stock_quantity: 25,
      },
      {
        name: "Chocolate Bar",
        category: "Snacks",
        type: "good",
        sku: "SNK-CHO-001",
        barcode: "5000159484695",
        shortcut_code: "202",
        price: 0.9,
        cost_price: 0.4,
        stock_quantity: 50,
      },
      {
        name: "Bread",
        category: "Bakery",
        type: "good",
        sku: "BAK-BRD-001",
        barcode: "6001206100007",
        shortcut_code: "301",
        price: 1.1,
        cost_price: 0.7,
        stock_quantity: 22,
      },
      {
        name: "Milk 1L",
        category: "Dairy",
        type: "good",
        sku: "DAR-MLK-1L",
        barcode: "6001052001234",
        shortcut_code: "401",
        price: 1.3,
        cost_price: 0.9,
        stock_quantity: 16,
      },
      {
        name: "Eggs (12)",
        category: "Dairy",
        type: "good",
        sku: "DAR-EGG-12",
        barcode: "6009876543210",
        shortcut_code: "402",
        price: 2.4,
        cost_price: 1.8,
        stock_quantity: 12,
      },
      {
        name: "USB-C Cable",
        category: "Accessories",
        type: "good",
        sku: "ACC-USBC-1M",
        barcode: "6971234567890",
        shortcut_code: "501",
        price: 3.5,
        cost_price: 2.2,
        stock_quantity: 10,
      },
      {
        name: "Phone Charger",
        category: "Accessories",
        type: "good",
        sku: "ACC-CHR-20W",
        barcode: "6970987654321",
        shortcut_code: "502",
        price: 6.0,
        cost_price: 3.8,
        stock_quantity: 8,
      },
      {
        name: "Screen Protector",
        category: "Accessories",
        type: "good",
        sku: "ACC-SCR-001",
        barcode: "6921234509876",
        shortcut_code: "503",
        price: 2.5,
        cost_price: 1.0,
        stock_quantity: 20,
      },
      {
        name: "Headphones",
        category: "Accessories",
        type: "good",
        sku: "ACC-HDP-001",
        barcode: "6955555012345",
        shortcut_code: "504",
        price: 8.0,
        cost_price: 5.2,
        stock_quantity: 3, // deliberately low to trigger low-stock UI
      },
      {
        name: "AA Batteries (4 pack)",
        category: "Accessories",
        type: "good",
        sku: "ACC-BAT-AA4",
        barcode: "4891234560000",
        shortcut_code: "505",
        price: 2.0,
        cost_price: 1.1,
        stock_quantity: 0, // out-of-stock to exercise UI states
      },
      {
        name: "Phone Case (Generic)",
        category: "Accessories",
        type: "good",
        sku: "ACC-CASE-001",
        barcode: "4891234561111",
        shortcut_code: "506",
        price: 4.0,
        cost_price: 2.0,
        stock_quantity: 2, // low
      },
      {
        name: "SIM Registration",
        category: "Services",
        type: "service",
        sku: "SRV-SIM-REG",
        barcode: null,
        shortcut_code: "901",
        price: 1.0,
        cost_price: 0,
        stock_quantity: 0,
      },
      {
        name: "Phone Cleaning",
        category: "Services",
        type: "service",
        sku: "SRV-PHN-CLN",
        barcode: null,
        shortcut_code: "902",
        price: 2.0,
        cost_price: 0,
        stock_quantity: 0,
      },
      {
        name: "Basic Repair Fee",
        category: "Services",
        type: "service",
        sku: "SRV-RPR-BSC",
        barcode: null,
        shortcut_code: "903",
        price: 5.0,
        cost_price: 0,
        stock_quantity: 0,
      },
    ];

    const seeded = seedProducts.map((p) => {
      const id = crypto.randomUUID();
      return {
        id,
        business_id: createdBusinessId,
        name: p.name,
        category: p.category,
        type: p.type,
        sku: p.sku,
        barcode: p.barcode,
        shortcut_code: p.shortcut_code,
        price: p.price,
        cost_price: p.cost_price,
        stock_quantity: p.stock_quantity,
        low_stock_threshold: 5,
        is_archived: false,
      };
    });

    const { error: prodErr } = await admin.from("products").insert(seeded as any);
    if (prodErr) return json(500, { error: "Failed to seed products" }, cors);

    // Seed a bit of sales history so reports aren't empty.
    const pick = <T,>(arr: T[]) => arr[Math.floor(Math.random() * arr.length)];
    const paymentMethods = ["cash", "card", "ecocash", "mobile"];

    const goods = seeded.filter((p: any) => String(p.type) !== "service");
    const allItems = seeded;

    const orders: any[] = [];
    const orderItems: any[] = [];

    const now = Date.now();

    for (let i = 0; i < 25; i++) {
      const orderId = crypto.randomUUID();

      const daysAgo = i < 4 ? 0 : Math.floor(Math.random() * 7); // ensure some are today
      const hour = 9 + Math.floor(Math.random() * 10); // 09:00 - 18:59
      const minute = Math.floor(Math.random() * 60);
      const created = new Date(now - daysAgo * 24 * 60 * 60 * 1000);
      created.setHours(hour, minute, Math.floor(Math.random() * 60), 0);
      const created_at = created.toISOString();

      const y = created.getFullYear();
      const m = String(created.getMonth() + 1).padStart(2, "0");
      const d = String(created.getDate()).padStart(2, "0");
      const dateKey = `${y}${m}${d}`;

      const receiptSuffix = randomString(6, "0123456789");
      const receipt_number = `BXI-${dateKey}-${receiptSuffix}`;
      const receipt_id = crypto.randomUUID();

      const itemCount = 1 + Math.floor(Math.random() * 4);

      let subtotal = 0;
      for (let j = 0; j < itemCount; j++) {
        const product = j === 0 ? pick(goods) : pick(allItems);
        const qty = String(product.type) === "service" ? 1 : 1 + Math.floor(Math.random() * 3);
        const price = Number(product.price || 0);
        const cost = Number(product.cost_price || 0);
        subtotal += price * qty;

        orderItems.push({
          id: crypto.randomUUID(),
          business_id: createdBusinessId,
          order_id: orderId,
          product_id: product.id,
          product_name: product.name,
          quantity: qty,
          price_at_sale: price,
          cost_at_sale: cost,
          created_at,
        });
      }

      const total = Math.round(subtotal * 100) / 100;

      orders.push({
        id: orderId,
        business_id: createdBusinessId,
        cashier_id: createdUserId,
        customer_name: null,
        customer_contact: null,
        total_amount: total,
        payment_method: pick(paymentMethods),
        status: "completed",
        receipt_id,
        receipt_number,
        subtotal_amount: total,
        discount_amount: 0,
        tax_amount: 0,
        created_at,
        updated_at: created_at,
        sale_type: "product",
        booking_id: null,
      });
    }

    const { error: orderErr } = await admin.from("orders").insert(orders as any);
    if (orderErr) return json(500, { error: "Failed to seed orders" }, cors);

    const { error: itemsErr } = await admin.from("order_items").insert(orderItems as any);
    if (itemsErr) return json(500, { error: "Failed to seed order items" }, cors);

    // Seed a few expenses so the Expenses/Profit pages aren't empty.
    try {
      const expenses = [
        {
          business_id: createdBusinessId,
          user_id: createdUserId,
          created_by: createdUserId,
          source: "demo",
          occurred_at: new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString(),
          category: "Rent",
          notes: "Shop rent (demo)",
          amount: 35,
          payment_method: "cash",
          expense_type: "expense",
          synced_at: new Date().toISOString(),
        },
        {
          business_id: createdBusinessId,
          user_id: createdUserId,
          created_by: createdUserId,
          source: "demo",
          occurred_at: new Date(now - 1 * 24 * 60 * 60 * 1000).toISOString(),
          category: "Supplies",
          notes: "Packaging + cleaning supplies (demo)",
          amount: 12.5,
          payment_method: "cash",
          expense_type: "expense",
          synced_at: new Date().toISOString(),
        },
        {
          business_id: createdBusinessId,
          user_id: createdUserId,
          created_by: createdUserId,
          source: "demo",
          occurred_at: new Date(now - 6 * 60 * 60 * 1000).toISOString(),
          category: "Transport",
          notes: "Supplier pickup (demo)",
          amount: 6,
          payment_method: "cash",
          expense_type: "expense",
          synced_at: new Date().toISOString(),
        },
        {
          business_id: createdBusinessId,
          user_id: createdUserId,
          created_by: createdUserId,
          source: "demo",
          occurred_at: new Date(now - 3 * 60 * 60 * 1000).toISOString(),
          category: "Owner drawing",
          notes: "Owner cash withdrawal (demo)",
          amount: 10,
          payment_method: "cash",
          expense_type: "owner_draw",
          synced_at: new Date().toISOString(),
        },
      ];

      await admin.from("expenses").insert(expenses as any);
    } catch {
      // Best-effort: do not fail demo provisioning if seeding fails.
    }

    // Seed a few service bookings so the service bookings list isn't empty.
    try {
      const services = seeded.filter((p: any) => String(p.type) === "service");
      const pickService = () => (services.length ? pick(services) : pick(seeded));

      const mk = (opts: {
        customer: string;
        hoursFromNow: number;
        status: "booked" | "completed" | "cancelled";
        deposit: number;
        total: number;
      }) => {
        const svc = pickService();
        const when = new Date(now + opts.hoursFromNow * 60 * 60 * 1000);
        const booking_date_time = when.toISOString();
        return {
          business_id: createdBusinessId,
          service_id: svc.id,
          service_name: svc.name,
          customer_name: opts.customer,
          booking_date_time,
          deposit_amount: opts.deposit,
          total_price: opts.total,
          status: opts.status,
          created_at: booking_date_time,
          updated_at: booking_date_time,
        };
      };

      const bookings = [
        mk({ customer: "Tariro", hoursFromNow: 2, status: "booked", deposit: 0, total: 5 }),
        mk({ customer: "Brian", hoursFromNow: 26, status: "booked", deposit: 1, total: 8 }),
        mk({ customer: "Rudo", hoursFromNow: -30, status: "completed", deposit: 2, total: 10 }),
      ];

      await admin.from("service_bookings").insert(bookings as any);
    } catch {
      // Best-effort: do not fail demo provisioning if seeding fails.
    }

    // Track demo session metadata (server-only)
    const { error: sessErr } = await admin.from("demo_sessions").insert(
      {
        expires_at,
        ip_hash,
        email,
        business_id: createdBusinessId,
        user_id: createdUserId,
        username,
        user_agent: req.headers.get("user-agent") || null,
      } as any
    );
    if (sessErr) return json(500, { error: "Failed to record demo session" }, cors);

    return json(
      200,
      { ok: true, username, password, expires_at },
      { ...cors, "Cache-Control": "no-store" }
    );
  } catch (e: any) {
    // Best-effort cleanup for partial provisioning.
    try {
      if (createdUserId) {
        await admin.auth.admin.deleteUser(createdUserId).catch(() => void 0);
      }
    } catch {
      // ignore
    }

    try {
      if (createdBusinessId) {
        await admin.from("orders").delete().eq("business_id", createdBusinessId);
        await admin.from("order_items").delete().eq("business_id", createdBusinessId);
        await admin.from("products").delete().eq("business_id", createdBusinessId);
        await admin.from("expenses").delete().eq("business_id", createdBusinessId);
        await admin.from("service_bookings").delete().eq("business_id", createdBusinessId);
        await admin.from("store_settings").delete().eq("business_id", createdBusinessId);
        await admin.from("app_feedback").delete().eq("business_id", createdBusinessId);
        await admin.from("business_devices").delete().eq("business_id", createdBusinessId);
        await admin.from("businesses").delete().eq("id", createdBusinessId);
      }
    } catch {
      // ignore
    }

    return json(500, { error: "Unhandled error", details: e?.message || String(e) }, cors);
  }
});
