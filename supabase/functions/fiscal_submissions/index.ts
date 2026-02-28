import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { corsHeaders, json } from "../_shared/cors.ts";
import {
  getBearerToken,
  getSupabaseEnv,
  isClearlyNotAUserJwt,
  supabaseAdminClient,
  supabaseAuthClient,
} from "../_shared/supabase.ts";

type CallerRow = {
  role: string | null;
  active: boolean | null;
  business_id: string | null;
};

const ADMIN_ROLES = new Set(["admin", "platform_admin", "master_admin", "super_admin"]);

function normalizeRole(role: unknown) {
  return String(role || "").trim().toLowerCase();
}

function isAdminRole(role: unknown) {
  return ADMIN_ROLES.has(normalizeRole(role));
}

function nullable(value: unknown, max = 400) {
  const v = String(value ?? "").trim();
  if (!v) return null;
  return v.length > max ? v.slice(0, max) : v;
}

function hashPayload(payload: unknown) {
  const raw = JSON.stringify(payload ?? {});
  let hash = 0;
  for (let i = 0; i < raw.length; i += 1) {
    hash = (hash << 5) - hash + raw.charCodeAt(i);
    hash |= 0;
  }
  return `h${Math.abs(hash)}`;
}

async function resolveCaller(req: Request) {
  const env = getSupabaseEnv();
  const jwt = getBearerToken(req);

  if (!jwt || isClearlyNotAUserJwt(jwt, env)) {
    return { error: json(401, { error: "Missing or invalid user session" }) } as const;
  }

  const userClient = supabaseAuthClient(env, jwt);
  const {
    data: { user },
    error: userErr,
  } = await userClient.auth.getUser();

  if (userErr || !user) return { error: json(401, { error: "Invalid user session" }) } as const;

  const admin = supabaseAdminClient(env);
  const { data: caller, error: callerErr } = await admin
    .from("profiles")
    .select("role, active, business_id")
    .eq("id", user.id)
    .maybeSingle();

  if (callerErr) return { error: json(500, { error: "Failed to resolve caller profile" }) } as const;
  if (!caller || caller.active === false) return { error: json(403, { error: "Account disabled" }) } as const;

  return { admin, caller: caller as CallerRow, userId: user.id } as const;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "GET" && req.method !== "POST") return json(405, { error: "Method not allowed" });

  try {
    const resolved = await resolveCaller(req);
    if ("error" in resolved) return resolved.error;

    const { admin, caller, userId } = resolved;
    if (!isAdminRole(caller.role)) return json(403, { error: "Admins only" });

    const tenantId = String(caller.business_id || "").trim();
    if (!tenantId) return json(400, { error: "Tenant context missing on your profile" });

    if (req.method === "GET") {
      const url = new URL(req.url);
      const status = nullable(url.searchParams.get("status"), 32);

      let q = admin
        .from("fdms_submission_logs")
        .select("id, tenant_id, device_id, submission_type, request_hash, idempotency_key, status, fdms_reference, response_excerpt, error_message, created_at, updated_at")
        .eq("tenant_id", tenantId)
        .order("created_at", { ascending: false })
        .limit(200);
      if (status) q = q.eq("status", status);

      const { data, error } = await q;
      if (error) return json(500, { error: "Failed to load submission logs" });

      const { data: jobs } = await admin
        .from("fdms_retry_jobs")
        .select("id, submission_log_id, job_type, status, attempt_count, max_attempts, next_run_at, last_error, dead_letter_reason, created_at, updated_at")
        .eq("tenant_id", tenantId)
        .order("next_run_at", { ascending: true })
        .limit(200);

      return json(200, { ok: true, logs: data || [], jobs: jobs || [] });
    }

    const body = await req.json().catch(() => ({} as any));
    const submissionType = String(body?.submissionType || "").trim().toLowerCase();
    if (!submissionType || !["receipt", "file"].includes(submissionType)) {
      return json(400, { error: "submissionType must be receipt or file" });
    }

    const requestPayload = body?.requestPayload ?? body?.payload ?? {};
    const idempotencyKey = nullable(body?.idempotencyKey, 200) || `idem-${crypto.randomUUID()}`;
    const requestHash = nullable(body?.requestHash, 200) || hashPayload(requestPayload);
    const deviceId = nullable(body?.deviceId, 64);
    const initialStatus = ["queued", "submitted", "accepted", "rejected", "failed"].includes(
      String(body?.status || "")
    )
      ? String(body.status)
      : "queued";

    const { data: inserted, error: insErr } = await admin
      .from("fdms_submission_logs")
      .insert({
        tenant_id: tenantId,
        device_id: deviceId,
        submission_type: submissionType,
        request_hash: requestHash,
        idempotency_key: idempotencyKey,
        status: initialStatus,
        request_payload: requestPayload,
      })
      .select("id, tenant_id, device_id, submission_type, request_hash, idempotency_key, status, fdms_reference, response_excerpt, error_message, created_at, updated_at")
      .single();

    if (insErr) return json(500, { error: "Failed to create submission log" });

    const enqueueRetry = body?.enqueueRetry !== false;
    let retryJob: any = null;

    if (enqueueRetry && ["queued", "failed", "submitted"].includes(initialStatus)) {
      const jobType = submissionType === "file" ? "submit_file" : "submit_receipt";
      const { data: jobData } = await admin
        .from("fdms_retry_jobs")
        .insert({
          tenant_id: tenantId,
          submission_log_id: inserted.id,
          job_type: jobType,
          status: "pending",
          next_run_at: new Date().toISOString(),
          max_attempts: 8,
        })
        .select("id, submission_log_id, job_type, status, attempt_count, max_attempts, next_run_at, last_error, dead_letter_reason, created_at, updated_at")
        .single();

      retryJob = jobData || null;
    }

    await admin.from("fdms_audit_logs").insert({
      tenant_id: tenantId,
      actor_user_id: userId,
      action: "submission.create",
      entity_type: "fdms_submission_logs",
      entity_id: inserted.id,
      details: { submission_type: submissionType, idempotency_key: idempotencyKey, status: initialStatus },
    });

    return json(200, { ok: true, log: inserted, retryJob });
  } catch (e) {
    return json(500, { error: "Unhandled error", details: e instanceof Error ? e.message : String(e) });
  }
});
