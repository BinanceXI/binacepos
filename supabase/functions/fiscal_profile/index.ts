import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { corsHeaders, json } from "../_shared/cors.ts";
import {
  getBearerToken,
  getSupabaseEnv,
  isClearlyNotAUserJwt,
  supabaseAdminClient,
  supabaseAuthClient,
} from "../_shared/supabase.ts";
import { warnIfFdmsMtlsMissingForEnabledTenants } from "../_shared/fdms.ts";

type CallerRow = {
  role: string | null;
  active: boolean | null;
  business_id: string | null;
};

const ADMIN_ROLES = new Set(["admin", "platform_admin", "master_admin", "super_admin"]);

function isAdminRole(role: string | null | undefined) {
  return ADMIN_ROLES.has(String(role || "").trim().toLowerCase());
}

function toNullableString(v: unknown, max = 500) {
  const s = String(v ?? "").trim();
  if (!s) return null;
  return s.length > max ? s.slice(0, max) : s;
}

function parseAddressJson(value: unknown) {
  if (value == null || value === "") return {};
  if (typeof value === "string") {
    const raw = value.trim();
    if (!raw) return {};
    return JSON.parse(raw);
  }
  if (typeof value === "object") return value;
  throw new Error("address_json must be a JSON object/string");
}

function mapRowToApi(row: any) {
  if (!row) return null;
  return {
    tenantId: row.tenant_id,
    enabled: !!row.enabled,
    environment: row.environment || "test",
    taxpayerTin: row.taxpayer_tin ?? "",
    vatNumber: row.vat_number ?? "",
    legalName: row.legal_name ?? "",
    tradeName: row.trade_name ?? "",
    address_json: row.address_json ?? {},
    buyerPolicy: row.buyer_policy ?? "",
    deviceOperatingMode: row.device_operating_mode ?? "",
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

    const { admin, caller } = resolved;

    await warnIfFdmsMtlsMissingForEnabledTenants(admin);

    if (!isAdminRole(caller.role)) return json(403, { error: "Admins only" });

    const tenantId = String(caller.business_id || "").trim();
    if (!tenantId) {
      return json(400, { error: "Tenant context missing on your profile (business_id)" });
    }

    if (req.method === "GET") {
      const { data, error } = await admin
        .from("tenant_fiscal_profiles")
        .select(
          "tenant_id, enabled, environment, taxpayer_tin, vat_number, legal_name, trade_name, address_json, buyer_policy, device_operating_mode, created_at, updated_at"
        )
        .eq("tenant_id", tenantId)
        .maybeSingle();

      if (error) return json(500, { error: "Failed to load fiscal profile" });
      return json(200, { ok: true, profile: mapRowToApi(data) });
    }

    const body = await req.json().catch(() => ({}));
    const environment = String((body as any)?.environment || "test").trim().toLowerCase();
    if (environment !== "test" && environment !== "prod") {
      return json(400, { error: "environment must be 'test' or 'prod'" });
    }

    const buyerPolicyRaw = toNullableString((body as any)?.buyerPolicy, 20);
    if (buyerPolicyRaw && !["optional", "required"].includes(buyerPolicyRaw)) {
      return json(400, { error: "buyerPolicy must be 'optional' or 'required'" });
    }

    const modeRaw = toNullableString((body as any)?.deviceOperatingMode, 20);
    if (modeRaw && !["Online", "Offline", "Hybrid"].includes(modeRaw)) {
      return json(400, { error: "deviceOperatingMode must be Online/Offline/Hybrid" });
    }

    let addressJson: unknown = {};
    try {
      addressJson = parseAddressJson((body as any)?.address_json);
    } catch {
      return json(400, { error: "Invalid address_json (must be valid JSON)" });
    }

    const upsertRow = {
      tenant_id: tenantId,
      enabled: !!(body as any)?.enabled,
      environment,
      taxpayer_tin: toNullableString((body as any)?.taxpayerTin, 120),
      vat_number: toNullableString((body as any)?.vatNumber, 120),
      legal_name: toNullableString((body as any)?.legalName, 255),
      trade_name: toNullableString((body as any)?.tradeName, 255),
      address_json: addressJson,
      buyer_policy: buyerPolicyRaw,
      device_operating_mode: modeRaw,
    };

    const { data, error } = await admin
      .from("tenant_fiscal_profiles")
      .upsert(upsertRow, { onConflict: "tenant_id" })
      .select(
        "tenant_id, enabled, environment, taxpayer_tin, vat_number, legal_name, trade_name, address_json, buyer_policy, device_operating_mode, created_at, updated_at"
      )
      .single();

    if (error) return json(500, { error: "Failed to save fiscal profile" });
    return json(200, { ok: true, profile: mapRowToApi(data) });
  } catch (e) {
    return json(500, { error: "Unhandled error", details: e instanceof Error ? e.message : String(e) });
  }
});
