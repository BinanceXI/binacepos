// ZIMRA FDMS client shared module.
// Supports global env certs and per-tenant encrypted cert material.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { decryptSecret } from "./fdmsCrypto.ts";

export type FdmsEnvName = "test" | "prod";
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
  mtlsCacheKey: string;
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

function mtlsMaterialCacheKey(clientCertPem: string | null, clientKeyPem: string | null, caCertPem: string | null) {
  return `${clientCertPem?.length || 0}:${clientKeyPem?.length || 0}:${caCertPem?.length || 0}`;
}

export function getFdmsRuntimeConfig(): FdmsRuntimeConfig {
  const env = normalizeEnvName(Deno.env.get("FDMS_ENV"));
  const clientCertPem = normalizePem(Deno.env.get("FDMS_CLIENT_CERT_PEM"));
  const clientKeyPem = normalizePem(Deno.env.get("FDMS_CLIENT_KEY_PEM"));
  const caCertPem = normalizePem(Deno.env.get("FDMS_CA_CERT_PEM"));
  return {
    env,
    baseUrl: FDMS_BASE_URLS[env],
    clientCertPem,
    clientKeyPem,
    caCertPem,
    endpointPrefix: normalizePrefix(Deno.env.get("FDMS_ENDPOINT_PREFIX")),
    mtlsCacheKey: `env:${env}:${mtlsMaterialCacheKey(clientCertPem, clientKeyPem, caCertPem)}`,
  };
}

function hasMtlsMaterial(cfg: FdmsRuntimeConfig) {
  return !!cfg.clientCertPem && !!cfg.clientKeyPem;
}

const mtlsClients = new Map<string, Deno.HttpClient>();

function getMtlsHttpClient(cfg: FdmsRuntimeConfig): Deno.HttpClient {
  if (!cfg.clientCertPem || !cfg.clientKeyPem) {
    throw new Error("FDMS mTLS is not configured (missing client certificate/private key)");
  }

  const cached = mtlsClients.get(cfg.mtlsCacheKey);
  if (cached) return cached;

  const client = Deno.createHttpClient({
    certChain: cfg.clientCertPem,
    privateKey: cfg.clientKeyPem,
    ...(cfg.caCertPem ? { caCerts: [cfg.caCertPem] } : {}),
  });
  mtlsClients.set(cfg.mtlsCacheKey, client);
  return client;
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

async function fdmsRequestWithConfig(
  cfg: FdmsRuntimeConfig,
  name: FdmsEndpointKey,
  payload?: FdmsPayload
): Promise<FdmsJson> {
  const spec = FDMS_ENDPOINTS[name];
  const path = `${cfg.endpointPrefix}${spec.path}`;
  const url = `${cfg.baseUrl}${path}`;

  const headers: Record<string, string> = { Accept: "application/json" };

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

type FdmsClientShape = {
  verifyTaxpayerInformation(payload: FdmsPayload): Promise<FdmsJson>;
  registerDevice(payload: FdmsPayload): Promise<FdmsJson>;
  getServerCertificate(): Promise<FdmsJson>;
  issueCertificate(payload: FdmsPayload): Promise<FdmsJson>;
  getConfig(payload: FdmsPayload): Promise<FdmsJson>;
  openDay(payload: FdmsPayload): Promise<FdmsJson>;
  submitReceipt(payload: FdmsPayload): Promise<FdmsJson>;
  closeDay(payload: FdmsPayload): Promise<FdmsJson>;
  submitFile(payload: FdmsPayload): Promise<FdmsJson>;
  getFileStatus(payload: FdmsPayload): Promise<FdmsJson>;
};

function createFdmsClient(resolveConfig: () => Promise<FdmsRuntimeConfig>): FdmsClientShape {
  return {
    async verifyTaxpayerInformation(payload: FdmsPayload) {
      return fdmsRequestWithConfig(await resolveConfig(), "verifyTaxpayerInformation", payload);
    },
    async registerDevice(payload: FdmsPayload) {
      return fdmsRequestWithConfig(await resolveConfig(), "registerDevice", payload);
    },
    async getServerCertificate() {
      return fdmsRequestWithConfig(await resolveConfig(), "getServerCertificate");
    },
    async issueCertificate(payload: FdmsPayload) {
      return fdmsRequestWithConfig(await resolveConfig(), "issueCertificate", payload);
    },
    async getConfig(payload: FdmsPayload) {
      return fdmsRequestWithConfig(await resolveConfig(), "getConfig", payload);
    },
    async openDay(payload: FdmsPayload) {
      return fdmsRequestWithConfig(await resolveConfig(), "openDay", payload);
    },
    async submitReceipt(payload: FdmsPayload) {
      return fdmsRequestWithConfig(await resolveConfig(), "submitReceipt", payload);
    },
    async closeDay(payload: FdmsPayload) {
      return fdmsRequestWithConfig(await resolveConfig(), "closeDay", payload);
    },
    async submitFile(payload: FdmsPayload) {
      return fdmsRequestWithConfig(await resolveConfig(), "submitFile", payload);
    },
    async getFileStatus(payload: FdmsPayload) {
      return fdmsRequestWithConfig(await resolveConfig(), "getFileStatus", payload);
    },
  };
}

type TenantCredentialRow = {
  key_version: number | null;
  encrypted_client_cert: string | null;
  encrypted_client_key: string | null;
  encrypted_ca_cert: string | null;
};

async function resolveTenantEnv(
  admin: SupabaseClient,
  tenantId: string,
  envOverride?: FdmsEnvName
): Promise<FdmsEnvName> {
  if (envOverride) return envOverride;
  const { data, error } = await admin
    .from("tenant_fiscal_profiles")
    .select("environment")
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (error) throw new Error(`Failed to resolve tenant fiscal environment: ${error.message}`);
  return normalizeEnvName((data as any)?.environment || "test");
}

async function resolveTenantConfig(
  admin: SupabaseClient,
  tenantId: string,
  envOverride?: FdmsEnvName
): Promise<FdmsRuntimeConfig> {
  const tenant = String(tenantId || "").trim();
  if (!tenant) throw new Error("Missing tenantId for tenant FDMS client");

  const env = await resolveTenantEnv(admin, tenant, envOverride);

  const { data, error } = await admin
    .from("fdms_tenant_credentials")
    .select("key_version, encrypted_client_cert, encrypted_client_key, encrypted_ca_cert")
    .eq("tenant_id", tenant)
    .eq("environment", env)
    .eq("active", true)
    .order("key_version", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(`Failed to load tenant FDMS credentials: ${error.message}`);
  if (!data) throw new Error(`No active FDMS credentials for tenant ${tenant} (${env})`);

  const row = data as TenantCredentialRow;
  if (!row.encrypted_client_cert || !row.encrypted_client_key) {
    throw new Error(`Tenant FDMS credentials are incomplete for tenant ${tenant} (${env})`);
  }

  const clientCertPem = normalizePem(await decryptSecret(row.encrypted_client_cert));
  const clientKeyPem = normalizePem(await decryptSecret(row.encrypted_client_key));
  const caCertPem = row.encrypted_ca_cert ? normalizePem(await decryptSecret(row.encrypted_ca_cert)) : null;

  return {
    env,
    baseUrl: FDMS_BASE_URLS[env],
    clientCertPem,
    clientKeyPem,
    caCertPem,
    endpointPrefix: normalizePrefix(Deno.env.get("FDMS_ENDPOINT_PREFIX")),
    mtlsCacheKey: `tenant:${tenant}:${env}:v${Number(row.key_version || 0)}:${mtlsMaterialCacheKey(
      clientCertPem,
      clientKeyPem,
      caCertPem
    )}`,
  };
}

export const fdmsClient = createFdmsClient(async () => getFdmsRuntimeConfig());

export async function getTenantFdmsClient(opts: {
  admin: SupabaseClient;
  tenantId: string;
  environment?: FdmsEnvName;
}) {
  const cfg = await resolveTenantConfig(opts.admin, opts.tenantId, opts.environment);
  return createFdmsClient(async () => cfg);
}

let warnedMtlsMissingForEnabledTenants = false;
let checkedMtlsAgainstEnabledTenants = false;

export async function warnIfFdmsMtlsMissingForEnabledTenants(admin: SupabaseClient) {
  if (checkedMtlsAgainstEnabledTenants) return;
  checkedMtlsAgainstEnabledTenants = true;

  try {
    const { data: enabledRows, error: enabledErr } = await admin
      .from("tenant_fiscal_profiles")
      .select("tenant_id")
      .eq("enabled", true)
      .limit(5);

    if (enabledErr) {
      console.warn("[fdms] Startup validation skipped: could not query tenant_fiscal_profiles:", enabledErr.message);
      return;
    }
    if (!enabledRows || enabledRows.length === 0) return;

    const enabledTenantIds = enabledRows.map((r: any) => String(r?.tenant_id || "").trim()).filter(Boolean);
    const { data: credRows, error: credErr } = await admin
      .from("fdms_tenant_credentials")
      .select("tenant_id")
      .in("tenant_id", enabledTenantIds)
      .eq("active", true)
      .limit(1);

    if (credErr) {
      console.warn("[fdms] Startup validation skipped: could not query fdms_tenant_credentials:", credErr.message);
      return;
    }

    const hasTenantCreds = !!credRows && credRows.length > 0;
    const globalCfg = getFdmsRuntimeConfig();
    const hasGlobalMtls = hasMtlsMaterial(globalCfg);
    if (!hasTenantCreds && !hasGlobalMtls && !warnedMtlsMissingForEnabledTenants) {
      warnedMtlsMissingForEnabledTenants = true;
      console.warn(
        "[fdms] WARNING: Fiscalisation is enabled for at least one tenant, but no active tenant credentials and no global FDMS mTLS certs were found."
      );
    }
  } catch (e) {
    console.warn("[fdms] Startup validation skipped:", e instanceof Error ? e.message : String(e));
  }
}
