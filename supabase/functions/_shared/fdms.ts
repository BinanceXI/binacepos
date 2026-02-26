// ZIMRA FDMS client scaffolding (Phase A)
// Server-side only: intended for Supabase Edge Functions / Deno runtime.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

type FdmsEnvName = "test" | "prod";
type FdmsPayload = unknown;
type FdmsJson = Record<string, unknown> | unknown[] | string | number | boolean | null;

const FDMS_BASE_URLS: Record<FdmsEnvName, string> = {
  test: "https://fdmsapitest.zimra.co.zw",
  prod: "https://fdmsapi.zimra.co.zw",
};

type FdmsEndpointKey =
  | "verifyTaxpayerInformation"
  | "registerDevice"
  | "getServerCertificate"
  | "issueCertificate"
  | "getConfig"
  | "openDay"
  | "submitReceipt"
  | "closeDay"
  | "submitFile"
  | "getFileStatus";

// Default path prefix is a best-effort scaffold and can be overridden with FDMS_ENDPOINT_PREFIX.
const DEFAULT_ENDPOINT_PREFIX = "/Device/v1";

const FDMS_ENDPOINTS: Record<FdmsEndpointKey, { path: string; method: "GET" | "POST"; mtls: boolean }> = {
  verifyTaxpayerInformation: { path: "/verifyTaxpayerInformation", method: "POST", mtls: false },
  registerDevice: { path: "/registerDevice", method: "POST", mtls: false },
  getServerCertificate: { path: "/getServerCertificate", method: "GET", mtls: false },
  issueCertificate: { path: "/issueCertificate", method: "POST", mtls: true },
  getConfig: { path: "/getConfig", method: "POST", mtls: true },
  openDay: { path: "/openDay", method: "POST", mtls: true },
  submitReceipt: { path: "/submitReceipt", method: "POST", mtls: true },
  closeDay: { path: "/closeDay", method: "POST", mtls: true },
  submitFile: { path: "/submitFile", method: "POST", mtls: true },
  getFileStatus: { path: "/getFileStatus", method: "POST", mtls: true },
};

type FdmsRuntimeConfig = {
  env: FdmsEnvName;
  baseUrl: string;
  clientCertPem: string | null;
  clientKeyPem: string | null;
  caCertPem: string | null;
  endpointPrefix: string;
};

function normalizePem(value: string | null): string | null {
  const raw = String(value || "").trim();
  if (!raw) return null;
  return raw.includes("\n") ? raw : raw.replace(/\\n/g, "\n");
}

function normalizeEnvName(raw: string | null): FdmsEnvName {
  const v = String(raw || "test").trim().toLowerCase();
  return v === "prod" ? "prod" : "test";
}

function normalizePrefix(raw: string | null): string {
  const input = String(raw || DEFAULT_ENDPOINT_PREFIX).trim();
  if (!input) return "";
  const noTrail = input.endsWith("/") ? input.slice(0, -1) : input;
  return noTrail.startsWith("/") ? noTrail : `/${noTrail}`;
}

export function getFdmsRuntimeConfig(): FdmsRuntimeConfig {
  const env = normalizeEnvName(Deno.env.get("FDMS_ENV"));
  return {
    env,
    baseUrl: FDMS_BASE_URLS[env],
    clientCertPem: normalizePem(Deno.env.get("FDMS_CLIENT_CERT_PEM")),
    clientKeyPem: normalizePem(Deno.env.get("FDMS_CLIENT_KEY_PEM")),
    caCertPem: normalizePem(Deno.env.get("FDMS_CA_CERT_PEM")),
    endpointPrefix: normalizePrefix(Deno.env.get("FDMS_ENDPOINT_PREFIX")),
  };
}

function hasMtlsMaterial(cfg: FdmsRuntimeConfig) {
  return !!cfg.clientCertPem && !!cfg.clientKeyPem;
}

let mtlsClient: Deno.HttpClient | null = null;
let mtlsClientKey = "";

function getMtlsHttpClient(cfg: FdmsRuntimeConfig): Deno.HttpClient {
  if (!cfg.clientCertPem || !cfg.clientKeyPem) {
    throw new Error("FDMS mTLS is not configured (missing FDMS_CLIENT_CERT_PEM or FDMS_CLIENT_KEY_PEM)");
  }

  const key = `${cfg.clientCertPem.length}:${cfg.clientKeyPem.length}:${cfg.caCertPem?.length || 0}`;
  if (mtlsClient && mtlsClientKey === key) return mtlsClient;

  mtlsClient = Deno.createHttpClient({
    certChain: cfg.clientCertPem,
    privateKey: cfg.clientKeyPem,
    ...(cfg.caCertPem ? { caCerts: [cfg.caCertPem] } : {}),
  });
  mtlsClientKey = key;
  return mtlsClient;
}

async function readJsonOrText(res: Response): Promise<FdmsJson> {
  const contentType = (res.headers.get("content-type") || "").toLowerCase();
  if (contentType.includes("application/json")) {
    try {
      return await res.json();
    } catch {
      return null;
    }
  }
  const text = await res.text().catch(() => "");
  return text || null;
}

async function fdmsRequest(name: FdmsEndpointKey, payload?: FdmsPayload): Promise<FdmsJson> {
  const cfg = getFdmsRuntimeConfig();
  const spec = FDMS_ENDPOINTS[name];
  const path = `${cfg.endpointPrefix}${spec.path}`;
  const url = `${cfg.baseUrl}${path}`;

  const headers: Record<string, string> = {
    Accept: "application/json",
  };

  let body: string | undefined;
  if (spec.method !== "GET") {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(payload ?? {});
  }

  const init: RequestInit & { client?: Deno.HttpClient } = {
    method: spec.method,
    headers,
    ...(body ? { body } : {}),
  };

  if (spec.mtls) {
    init.client = getMtlsHttpClient(cfg);
  }

  const res = await fetch(url, init as RequestInit);
  const parsed = await readJsonOrText(res);

  if (!res.ok) {
    const details =
      typeof parsed === "string"
        ? parsed.slice(0, 300)
        : parsed && typeof parsed === "object"
          ? JSON.stringify(parsed).slice(0, 300)
          : String(parsed ?? "");
    throw new Error(`FDMS ${name} failed (${res.status})${details ? `: ${details}` : ""}`);
  }

  return parsed;
}

export const fdmsClient = {
  verifyTaxpayerInformation(payload: FdmsPayload) {
    return fdmsRequest("verifyTaxpayerInformation", payload);
  },
  registerDevice(payload: FdmsPayload) {
    return fdmsRequest("registerDevice", payload);
  },
  getServerCertificate() {
    return fdmsRequest("getServerCertificate");
  },
  issueCertificate(payload: FdmsPayload) {
    return fdmsRequest("issueCertificate", payload);
  },
  getConfig(payload: FdmsPayload) {
    return fdmsRequest("getConfig", payload);
  },
  openDay(payload: FdmsPayload) {
    return fdmsRequest("openDay", payload);
  },
  submitReceipt(payload: FdmsPayload) {
    return fdmsRequest("submitReceipt", payload);
  },
  closeDay(payload: FdmsPayload) {
    return fdmsRequest("closeDay", payload);
  },
  submitFile(payload: FdmsPayload) {
    return fdmsRequest("submitFile", payload);
  },
  getFileStatus(payload: FdmsPayload) {
    return fdmsRequest("getFileStatus", payload);
  },
};

let warnedMtlsMissingForEnabledTenants = false;
let checkedMtlsAgainstEnabledTenants = false;

export async function warnIfFdmsMtlsMissingForEnabledTenants(admin: SupabaseClient) {
  if (checkedMtlsAgainstEnabledTenants) return;
  checkedMtlsAgainstEnabledTenants = true;

  try {
    const { data, error } = await admin
      .from("tenant_fiscal_profiles")
      .select("tenant_id")
      .eq("enabled", true)
      .limit(1);

    if (error) {
      console.warn("[fdms] Startup validation skipped: could not query tenant_fiscal_profiles:", error.message);
      return;
    }

    if (!data || data.length === 0) return;

    const cfg = getFdmsRuntimeConfig();
    if (!hasMtlsMaterial(cfg) && !warnedMtlsMissingForEnabledTenants) {
      warnedMtlsMissingForEnabledTenants = true;
      console.warn(
        "[fdms] WARNING: Fiscalisation is enabled for at least one tenant, but FDMS mTLS env vars are missing. Set FDMS_CLIENT_CERT_PEM and FDMS_CLIENT_KEY_PEM (FDMS_CA_CERT_PEM optional)."
      );
    }
  } catch (e) {
    console.warn("[fdms] Startup validation skipped:", e instanceof Error ? e.message : String(e));
  }
}
