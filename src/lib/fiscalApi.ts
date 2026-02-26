import { supabase } from "@/lib/supabase";

export type BuyerPolicy = "optional" | "required" | "";
export type DeviceOperatingMode = "Online" | "Offline" | "Hybrid" | "";
export type FiscalEnvironment = "test" | "prod";

export type TenantFiscalProfile = {
  tenantId?: string;
  enabled: boolean;
  environment: FiscalEnvironment;
  taxpayerTin: string;
  vatNumber: string;
  legalName: string;
  tradeName: string;
  address_json: unknown;
  buyerPolicy: BuyerPolicy;
  deviceOperatingMode: DeviceOperatingMode;
  created_at?: string;
  updated_at?: string;
};

export const DEFAULT_TENANT_FISCAL_PROFILE: TenantFiscalProfile = {
  enabled: false,
  environment: "test",
  taxpayerTin: "",
  vatNumber: "",
  legalName: "",
  tradeName: "",
  address_json: {},
  buyerPolicy: "",
  deviceOperatingMode: "",
};

function functionsBaseUrl() {
  const url = String(import.meta.env.VITE_SUPABASE_URL || "").trim();
  if (!url) throw new Error("Missing VITE_SUPABASE_URL");
  return `${url.replace(/\/+$/, "")}/functions/v1`;
}

async function authHeaders(extra?: HeadersInit) {
  const [{ data }, anonKey] = await Promise.all([
    supabase.auth.getSession(),
    Promise.resolve(String(import.meta.env.VITE_SUPABASE_ANON_KEY || "").trim()),
  ]);

  const accessToken = data?.session?.access_token;
  if (!accessToken) throw new Error("Cloud session missing. Sign out and sign in again while online.");

  return {
    Authorization: `Bearer ${accessToken}`,
    ...(anonKey ? { apikey: anonKey } : {}),
    ...extra,
  };
}

async function parseApiResponse<T>(res: Response): Promise<T> {
  let data: any = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }

  if (!res.ok) {
    const msg = String(data?.error || `Request failed (${res.status})`);
    throw new Error(msg);
  }

  return data as T;
}

// These map to Supabase Edge Functions in this repo. If you add a reverse proxy later,
// you can point the same calls to /api/fiscal/profile and /api/fiscal/fdms/health.
export async function getFiscalProfile(): Promise<TenantFiscalProfile | null> {
  const res = await fetch(`${functionsBaseUrl()}/fiscal_profile`, {
    method: "GET",
    headers: await authHeaders(),
  });
  const data = await parseApiResponse<{ ok: true; profile: TenantFiscalProfile | null }>(res);
  if (!data?.ok) throw new Error("Failed to load fiscal profile");
  return data.profile;
}

export async function upsertFiscalProfile(
  profile: Partial<TenantFiscalProfile>
): Promise<TenantFiscalProfile> {
  const res = await fetch(`${functionsBaseUrl()}/fiscal_profile`, {
    method: "POST",
    headers: await authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(profile),
  });
  const data = await parseApiResponse<{ ok: true; profile: TenantFiscalProfile }>(res);
  if (!data?.ok) throw new Error("Failed to save fiscal profile");
  return data.profile;
}

export async function checkFdmsHealth(): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(`${functionsBaseUrl()}/fdms_health`, {
    method: "GET",
    headers: await authHeaders(),
  });
  return parseApiResponse<{ ok: boolean; error?: string }>(res);
}
