import { supabase } from "@/lib/supabase";
import { getOrCreateDeviceId } from "@/lib/deviceLicense";

export type BuyerPolicy = "optional" | "required" | "";
export type DeviceOperatingMode = "Online" | "Offline" | "Hybrid" | "";
export type FiscalEnvironment = "test" | "prod";
export type FiscalSubmissionType = "receipt" | "file";

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

export type FiscalCredentialMeta = {
  id: string;
  tenant_id: string;
  environment: FiscalEnvironment;
  key_version: number;
  active: boolean;
  rotated_at?: string | null;
  created_by?: string | null;
  created_at?: string;
  updated_at?: string;
};

export type FiscalDeviceRecord = {
  id: string;
  tenant_id: string;
  device_identifier: string;
  fdms_device_id?: string | null;
  registration_status: "pending" | "registered" | "failed";
  certificate_status: "pending" | "issued" | "failed";
  config_sync_status: "pending" | "synced" | "failed";
  day_state: "open" | "closed";
  last_heartbeat_at?: string | null;
  last_error?: string | null;
  created_at?: string;
  updated_at?: string;
};

export type FiscalSubmissionLog = {
  id: string;
  tenant_id: string;
  device_id?: string | null;
  device_identifier?: string | null;
  order_id?: string | null;
  receipt_id?: string | null;
  receipt_number?: string | null;
  submission_type: FiscalSubmissionType;
  request_hash?: string | null;
  idempotency_key?: string | null;
  status: "queued" | "submitted" | "accepted" | "rejected" | "failed";
  fdms_reference?: string | null;
  response_excerpt?: string | null;
  error_message?: string | null;
  created_at?: string;
  updated_at?: string;
};

export type FiscalRetryJob = {
  id: string;
  submission_log_id: string;
  job_type: "submit_receipt" | "submit_file" | "status_poll";
  status: "pending" | "running" | "completed" | "dead_letter";
  attempt_count: number;
  max_attempts: number;
  next_run_at: string;
  last_error?: string | null;
  dead_letter_reason?: string | null;
  created_at?: string;
  updated_at?: string;
};

export type FiscalSubmissionState = {
  logs: FiscalSubmissionLog[];
  jobs: FiscalRetryJob[];
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

export async function listFiscalCredentials(): Promise<FiscalCredentialMeta[]> {
  const res = await fetch(`${functionsBaseUrl()}/fiscal_credentials`, {
    method: "GET",
    headers: await authHeaders(),
  });
  const data = await parseApiResponse<{ ok: true; items: FiscalCredentialMeta[] }>(res);
  return Array.isArray(data?.items) ? data.items : [];
}

export async function uploadFiscalCredential(input: {
  environment: FiscalEnvironment;
  clientCertPem: string;
  clientKeyPem: string;
  caCertPem?: string;
  active?: boolean;
}): Promise<FiscalCredentialMeta> {
  const res = await fetch(`${functionsBaseUrl()}/fiscal_credentials`, {
    method: "POST",
    headers: await authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(input),
  });
  const data = await parseApiResponse<{ ok: true; item: FiscalCredentialMeta }>(res);
  if (!data?.item) throw new Error("Credential upload failed");
  return data.item;
}

export async function listFiscalDevices(): Promise<FiscalDeviceRecord[]> {
  const res = await fetch(`${functionsBaseUrl()}/fiscal_devices`, {
    method: "GET",
    headers: await authHeaders(),
  });
  const data = await parseApiResponse<{ ok: true; items: FiscalDeviceRecord[] }>(res);
  return Array.isArray(data?.items) ? data.items : [];
}

export async function upsertFiscalDevice(input: {
  deviceIdentifier: string;
  fdmsDeviceId?: string;
  registrationStatus?: "pending" | "registered" | "failed";
  certificateStatus?: "pending" | "issued" | "failed";
  configSyncStatus?: "pending" | "synced" | "failed";
  dayState?: "open" | "closed";
  lastHeartbeatAt?: string | null;
  lastError?: string;
}): Promise<FiscalDeviceRecord> {
  const res = await fetch(`${functionsBaseUrl()}/fiscal_devices`, {
    method: "POST",
    headers: await authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(input),
  });
  const data = await parseApiResponse<{ ok: true; item: FiscalDeviceRecord }>(res);
  if (!data?.item) throw new Error("Failed to save fiscal device");
  return data.item;
}

export async function getFiscalSubmissions(status?: string): Promise<FiscalSubmissionState> {
  const qs = status ? `?status=${encodeURIComponent(status)}` : "";
  const res = await fetch(`${functionsBaseUrl()}/fiscal_submissions${qs}`, {
    method: "GET",
    headers: await authHeaders(),
  });
  const data = await parseApiResponse<{ ok: true; logs: FiscalSubmissionLog[]; jobs: FiscalRetryJob[] }>(res);
  return {
    logs: Array.isArray(data?.logs) ? data.logs : [],
    jobs: Array.isArray(data?.jobs) ? data.jobs : [],
  };
}

export async function createFiscalSubmission(input: {
  submissionType: FiscalSubmissionType;
  requestPayload: unknown;
  idempotencyKey?: string;
  requestHash?: string;
  status?: "queued" | "submitted" | "accepted" | "rejected" | "failed";
  enqueueRetry?: boolean;
  deviceId?: string | null;
  deviceIdentifier?: string | null;
  orderId?: string | null;
  receiptId?: string | null;
  receiptNumber?: string | null;
}): Promise<{ log: FiscalSubmissionLog; retryJob: FiscalRetryJob | null }> {
  const res = await fetch(`${functionsBaseUrl()}/fiscal_submissions`, {
    method: "POST",
    headers: await authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(input),
  });
  const data = await parseApiResponse<{ ok: true; log: FiscalSubmissionLog; retryJob: FiscalRetryJob | null }>(res);
  if (!data?.log) throw new Error("Failed to queue fiscal submission");
  return { log: data.log, retryJob: data.retryJob ?? null };
}

export async function queueFiscalReceiptSubmission(input: {
  orderId: string;
  receiptId: string;
  receiptNumber: string;
  requestPayload: unknown;
  deviceIdentifier?: string | null;
  idempotencyKey?: string;
}) {
  const deviceIdentifier = String(input.deviceIdentifier || "").trim() || getOrCreateDeviceId();
  const idem =
    String(input.idempotencyKey || "").trim() ||
    `receipt:${String(input.receiptId || "").trim() || String(input.orderId || "").trim()}`;

  try {
    const out = await createFiscalSubmission({
      submissionType: "receipt",
      requestPayload: input.requestPayload,
      orderId: input.orderId,
      receiptId: input.receiptId,
      receiptNumber: input.receiptNumber,
      deviceIdentifier,
      idempotencyKey: idem,
      enqueueRetry: true,
      status: "queued",
    });
    return { ok: true as const, ...out };
  } catch (e: any) {
    const msg = String(e?.message || "Failed to queue fiscal receipt");
    if (msg.toLowerCase().includes("fiscalisation is disabled")) {
      return { ok: false as const, skipped: true as const, reason: "disabled" as const, error: msg };
    }
    return { ok: false as const, skipped: false as const, reason: "error" as const, error: msg };
  }
}
