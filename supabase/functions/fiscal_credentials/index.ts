import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { corsHeaders, json } from "../_shared/cors.ts";
import {
  getBearerToken,
  getSupabaseEnv,
  isClearlyNotAUserJwt,
  supabaseAdminClient,
  supabaseAuthClient,
} from "../_shared/supabase.ts";
import { encryptSecret } from "../_shared/fdmsCrypto.ts";

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

function asEnv(raw: unknown): "test" | "prod" {
  return String(raw || "test").trim().toLowerCase() === "prod" ? "prod" : "test";
}

function mapCredential(row: any) {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    environment: row.environment,
    key_version: row.key_version,
    active: !!row.active,
    rotated_at: row.rotated_at,
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
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
        .from("fdms_tenant_credentials")
        .select("id, tenant_id, environment, key_version, active, rotated_at, created_by, created_at, updated_at")
        .eq("tenant_id", tenantId)
        .order("created_at", { ascending: false })
        .limit(20);

      if (error) return json(500, { error: "Failed to load credentials" });
      return json(200, { ok: true, items: (data || []).map(mapCredential) });
    }

    const body = await req.json().catch(() => ({} as any));
    const environment = asEnv(body?.environment);
    const clientCertPem = String(body?.clientCertPem || "").trim();
    const clientKeyPem = String(body?.clientKeyPem || "").trim();
    const caCertPem = String(body?.caCertPem || "").trim();
    const active = body?.active !== false;

    if (!clientCertPem || !clientKeyPem) {
      return json(400, { error: "clientCertPem and clientKeyPem are required" });
    }

    const { data: maxRow, error: maxErr } = await admin
      .from("fdms_tenant_credentials")
      .select("key_version")
      .eq("tenant_id", tenantId)
      .eq("environment", environment)
      .order("key_version", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (maxErr) return json(500, { error: "Failed to resolve key version" });
    const keyVersion = Number((maxRow as any)?.key_version || 0) + 1;

    if (active) {
      await admin
        .from("fdms_tenant_credentials")
        .update({ active: false, rotated_at: new Date().toISOString() })
        .eq("tenant_id", tenantId)
        .eq("environment", environment)
        .eq("active", true);
    }

    const insertRow = {
      tenant_id: tenantId,
      environment,
      key_version: keyVersion,
      encrypted_client_cert: await encryptSecret(clientCertPem),
      encrypted_client_key: await encryptSecret(clientKeyPem),
      encrypted_ca_cert: caCertPem ? await encryptSecret(caCertPem) : null,
      active,
      rotated_at: active ? new Date().toISOString() : null,
      created_by: userId,
    };

    const { data, error } = await admin
      .from("fdms_tenant_credentials")
      .insert(insertRow)
      .select("id, tenant_id, environment, key_version, active, rotated_at, created_by, created_at, updated_at")
      .single();

    if (error) return json(500, { error: "Failed to save credentials" });

    await admin.from("fdms_audit_logs").insert({
      tenant_id: tenantId,
      actor_user_id: userId,
      action: "credential.upsert",
      entity_type: "fdms_tenant_credentials",
      entity_id: data.id,
      details: { environment, key_version: keyVersion, active },
    });

    return json(200, { ok: true, item: mapCredential(data) });
  } catch (e) {
    return json(500, { error: "Unhandled error", details: e instanceof Error ? e.message : String(e) });
  }
});
