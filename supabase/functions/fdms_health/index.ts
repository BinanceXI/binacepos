import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { corsHeaders, json } from "../_shared/cors.ts";
import {
  getBearerToken,
  getSupabaseEnv,
  isClearlyNotAUserJwt,
  supabaseAdminClient,
  supabaseAuthClient,
} from "../_shared/supabase.ts";
import { fdmsClient, warnIfFdmsMtlsMissingForEnabledTenants } from "../_shared/fdms.ts";

const ADMIN_ROLES = new Set(["admin", "platform_admin", "master_admin", "super_admin"]);

function sanitizeErrorMessage(err: unknown) {
  const raw = err instanceof Error ? err.message : String(err ?? "Unknown error");
  const scrubbed = raw
    .replace(/-----BEGIN[\s\S]*?-----END [A-Z ]+-----/g, "[redacted-pem]")
    .replace(/FDMS_CLIENT_(CERT|KEY|CA)_PEM/g, "[redacted-env]");
  return scrubbed.slice(0, 300) || "FDMS health check failed";
}

async function resolveAdmin(req: Request) {
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
    .select("role, active")
    .eq("id", user.id)
    .maybeSingle();

  if (callerErr) return { error: json(500, { error: "Failed to resolve caller profile" }) } as const;
  if (!caller || caller.active === false) return { error: json(403, { error: "Account disabled" }) } as const;
  if (!ADMIN_ROLES.has(String(caller.role || "").trim().toLowerCase())) {
    return { error: json(403, { error: "Admins only" }) } as const;
  }

  return { admin } as const;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "GET") return json(405, { error: "Method not allowed" });

  try {
    const resolved = await resolveAdmin(req);
    if ("error" in resolved) return resolved.error;

    await warnIfFdmsMtlsMissingForEnabledTenants(resolved.admin);

    try {
      await fdmsClient.getServerCertificate();
      return json(200, { ok: true });
    } catch (e) {
      return json(200, { ok: false, error: sanitizeErrorMessage(e) });
    }
  } catch (e) {
    return json(500, { ok: false, error: sanitizeErrorMessage(e) });
  }
});
