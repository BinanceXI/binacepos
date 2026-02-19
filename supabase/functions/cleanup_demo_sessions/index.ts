import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { corsHeaders, json } from "../_shared/cors.ts";
import { getSupabaseEnv, supabaseAdminClient } from "../_shared/supabase.ts";

type DemoSessionRow = {
  id: string;
  business_id: string | null;
  user_id: string | null;
  expires_at: string;
  purge_attempts?: number | null;
};

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

function secureEqual(a: string, b: string) {
  const aa = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  if (aa.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < aa.length; i++) diff |= aa[i] ^ bb[i];
  return diff === 0;
}

async function recordAudit(
  admin: ReturnType<typeof supabaseAdminClient>,
  row: {
    demo_session_id?: string | null;
    business_id?: string | null;
    user_id?: string | null;
    status: "success" | "failed";
    error?: string | null;
  }
) {
  try {
    await admin.from("demo_cleanup_audit").insert({
      demo_session_id: row.demo_session_id ?? null,
      business_id: row.business_id ?? null,
      user_id: row.user_id ?? null,
      status: row.status,
      error: row.error ?? null,
    } as any);
  } catch {
    // best effort audit
  }
}

async function deleteTenantRows(admin: ReturnType<typeof supabaseAdminClient>, businessId: string) {
  const byBusiness = [
    "order_items",
    "orders",
    "products",
    "expenses",
    "service_bookings",
    "store_settings",
    "app_feedback",
    "business_devices",
    "reactivation_codes",
    "billing_payments",
    "impersonation_audit",
  ];

  for (const table of byBusiness) {
    const { error } = await admin.from(table).delete().eq("business_id", businessId);
    if (error) {
      throw new Error(`Failed deleting ${table}: ${error.message}`);
    }
  }
}

async function deleteBusinessUsers(
  admin: ReturnType<typeof supabaseAdminClient>,
  businessId: string,
  preferredUserId: string | null
) {
  const { data: profiles, error: profileErr } = await admin
    .from("profiles")
    .select("id")
    .eq("business_id", businessId);

  if (profileErr) {
    throw new Error(`Failed reading business users: ${profileErr.message}`);
  }

  const userIds = new Set<string>();
  for (const row of (profiles as any[]) || []) {
    const id = String(row?.id || "").trim();
    if (id) userIds.add(id);
  }
  if (preferredUserId) userIds.add(String(preferredUserId));

  for (const userId of userIds) {
    const { error } = await admin.auth.admin.deleteUser(userId);
    // User may already be gone; don't fail the whole cleanup for that.
    if (error) {
      const msg = String(error.message || "").toLowerCase();
      const ignorable =
        msg.includes("not found") ||
        msg.includes("does not exist") ||
        msg.includes("could not find") ||
        msg.includes("no rows");
      if (!ignorable) {
        throw new Error(`Failed deleting auth user ${userId}: ${error.message}`);
      }
    }
  }

  // Safety: remove orphaned profile rows if any remain.
  const { error: profDeleteErr } = await admin.from("profiles").delete().eq("business_id", businessId);
  if (profDeleteErr) {
    throw new Error(`Failed deleting business profiles: ${profDeleteErr.message}`);
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });

  const expectedSecret = String(Deno.env.get("DEMO_CLEANUP_SECRET") || "").trim();
  const suppliedSecret = String(req.headers.get("x-demo-cleanup-secret") || "").trim();

  if (!expectedSecret) return json(500, { error: "Server misconfigured (missing DEMO_CLEANUP_SECRET)" });
  if (!suppliedSecret || !secureEqual(expectedSecret, suppliedSecret)) {
    return json(401, { error: "Unauthorized" });
  }

  const env = getSupabaseEnv();
  const admin = supabaseAdminClient(env);

  const nowIso = new Date().toISOString();
  const batchSize = clampInt(intEnv("DEMO_CLEANUP_BATCH_SIZE", 50), 1, 200);

  const { data, error } = await admin
    .from("demo_sessions")
    .select("id, business_id, user_id, expires_at, purge_attempts")
    .lte("expires_at", nowIso)
    .is("purged_at", null)
    .order("expires_at", { ascending: true })
    .limit(batchSize);

  if (error) return json(500, { error: "Failed to load expired sessions", details: error.message });

  const sessions = ((data as any[]) || []) as DemoSessionRow[];

  let processed = 0;
  let deleted = 0;
  let failed = 0;

  for (const row of sessions) {
    processed += 1;

    const sessionId = String(row?.id || "").trim() || null;
    const businessId = String(row?.business_id || "").trim() || null;
    const userId = String(row?.user_id || "").trim() || null;

    if (!sessionId) continue;

    let failureMessage: string | null = null;

    try {
      if (!businessId) {
        throw new Error("Missing business_id in demo session");
      }

      const { data: business, error: businessErr } = await admin
        .from("businesses")
        .select("id, is_demo")
        .eq("id", businessId)
        .maybeSingle();

      if (businessErr) {
        throw new Error(`Failed to verify business: ${businessErr.message}`);
      }

      if (!business) {
        // Business already gone; clean the dangling session row.
        await admin.from("demo_sessions").delete().eq("id", sessionId);
        await recordAudit(admin, {
          demo_session_id: sessionId,
          business_id: businessId,
          user_id: userId,
          status: "success",
          error: "Business already deleted; removed stale demo session",
        });
        deleted += 1;
        continue;
      }

      if ((business as any)?.is_demo !== true) {
        throw new Error("Refusing cleanup: business is not marked as demo");
      }

      await deleteTenantRows(admin, businessId);
      await deleteBusinessUsers(admin, businessId, userId);

      const { error: businessDeleteErr } = await admin.from("businesses").delete().eq("id", businessId);
      if (businessDeleteErr) throw new Error(`Failed deleting business: ${businessDeleteErr.message}`);

      // Best-effort in case the business delete did not cascade.
      await admin.from("demo_sessions").delete().eq("id", sessionId);

      await recordAudit(admin, {
        demo_session_id: sessionId,
        business_id: businessId,
        user_id: userId,
        status: "success",
      });

      deleted += 1;
    } catch (e: any) {
      failureMessage = e?.message || String(e);
      failed += 1;

      await admin
        .from("demo_sessions")
        .update({
          purge_attempts: Math.max(0, Number(row?.purge_attempts || 0)) + 1,
          last_purge_error: failureMessage,
        } as any)
        .eq("id", sessionId)
        .catch(() => void 0);

      await recordAudit(admin, {
        demo_session_id: sessionId,
        business_id: businessId,
        user_id: userId,
        status: "failed",
        error: failureMessage,
      });
    }
  }

  return json(200, {
    ok: true,
    processed,
    deleted,
    failed,
    now: nowIso,
    batch_size: batchSize,
  });
});
