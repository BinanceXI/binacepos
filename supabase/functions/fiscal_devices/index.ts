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
      const { data, error } = await admin
        .from("fdms_devices")
        .select("id, tenant_id, device_identifier, fdms_device_id, registration_status, certificate_status, config_sync_status, day_state, last_heartbeat_at, last_error, created_at, updated_at")
        .eq("tenant_id", tenantId)
        .order("created_at", { ascending: false });

      if (error) return json(500, { error: "Failed to load devices" });
      return json(200, { ok: true, items: data || [] });
    }

    const body = await req.json().catch(() => ({} as any));
    const deviceIdentifier = nullable(body?.deviceIdentifier, 255);
    if (!deviceIdentifier) return json(400, { error: "deviceIdentifier is required" });

    const row = {
      tenant_id: tenantId,
      device_identifier: deviceIdentifier,
      fdms_device_id: nullable(body?.fdmsDeviceId, 255),
      registration_status: ["pending", "registered", "failed"].includes(String(body?.registrationStatus || ""))
        ? String(body.registrationStatus)
        : "pending",
      certificate_status: ["pending", "issued", "failed"].includes(String(body?.certificateStatus || ""))
        ? String(body.certificateStatus)
        : "pending",
      config_sync_status: ["pending", "synced", "failed"].includes(String(body?.configSyncStatus || ""))
        ? String(body.configSyncStatus)
        : "pending",
      day_state: ["open", "closed"].includes(String(body?.dayState || "")) ? String(body.dayState) : "closed",
      last_heartbeat_at: body?.lastHeartbeatAt ? new Date(body.lastHeartbeatAt).toISOString() : null,
      last_error: nullable(body?.lastError, 2000),
    };

    const { data, error } = await admin
      .from("fdms_devices")
      .upsert(row, { onConflict: "tenant_id,device_identifier" })
      .select("id, tenant_id, device_identifier, fdms_device_id, registration_status, certificate_status, config_sync_status, day_state, last_heartbeat_at, last_error, created_at, updated_at")
      .single();

    if (error) return json(500, { error: "Failed to save device" });

    await admin.from("fdms_audit_logs").insert({
      tenant_id: tenantId,
      actor_user_id: userId,
      action: "device.upsert",
      entity_type: "fdms_devices",
      entity_id: data.id,
      details: {
        device_identifier: data.device_identifier,
        registration_status: data.registration_status,
        certificate_status: data.certificate_status,
        config_sync_status: data.config_sync_status,
        day_state: data.day_state,
      },
    });

    return json(200, { ok: true, item: data });
  } catch (e) {
    return json(500, { error: "Unhandled error", details: e instanceof Error ? e.message : String(e) });
  }
});
