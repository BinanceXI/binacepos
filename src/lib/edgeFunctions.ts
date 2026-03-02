import { supabase } from "@/lib/supabase";
import { ensureSupabaseSession, isLikelyAuthError } from "@/lib/supabaseSession";

type SupabaseFunctionInvokeOptions = {
  body?: unknown;
  headers?: Record<string, string>;
  region?: string;
};

export type InvokeWithAuthRecoveryOptions = SupabaseFunctionInvokeOptions & {
  ensureSession?: boolean;
  retryOnAuthError?: boolean;
  forceRefreshOnStart?: boolean;
};

export type EdgeInvokeError = Error & {
  functionName: string;
  status?: number;
  details?: string;
  data?: any;
  isAuthError: boolean;
};

function toEdgeInvokeError(functionName: string, err: any, data?: any): EdgeInvokeError {
  const statusRaw =
    Number((err as any)?.status) ||
    Number((data as any)?.statusCode) ||
    Number((data as any)?.status) ||
    0;
  const status = Number.isFinite(statusRaw) && statusRaw > 0 ? statusRaw : undefined;

  const message =
    String((data as any)?.error || (err as any)?.message || "").trim() || "Edge function request failed";

  const out = new Error(message) as EdgeInvokeError;
  out.functionName = functionName;
  out.status = status;
  out.details = String((data as any)?.details || "").trim() || undefined;
  out.data = data;
  out.isAuthError = isLikelyAuthError({ status, message });
  return out;
}

async function invokeEdgeFunction<TResponse = any>(
  functionName: string,
  invokeOptions: SupabaseFunctionInvokeOptions
): Promise<TResponse> {
  const { data, error } = await supabase.functions.invoke(functionName, invokeOptions as any);
  if (error) throw toEdgeInvokeError(functionName, error, data);

  // Some edge handlers return 200 with { error: ... } payloads.
  if (data && typeof data === "object" && "error" in (data as any)) {
    const payloadError = String((data as any)?.error || "").trim();
    if (payloadError) throw toEdgeInvokeError(functionName, { status: 400, message: payloadError }, data);
  }

  return data as TResponse;
}

export async function invokeWithAuthRecovery<TResponse = any>(
  functionName: string,
  opts?: InvokeWithAuthRecoveryOptions
): Promise<TResponse> {
  const ensureSession = opts?.ensureSession !== false;
  const retryOnAuthError = opts?.retryOnAuthError !== false;
  const forceRefreshOnStart = !!opts?.forceRefreshOnStart;
  const invokeOptions: SupabaseFunctionInvokeOptions = {
    body: opts?.body,
    headers: opts?.headers,
    region: opts?.region,
  };

  if (ensureSession) {
    const sessionRes = await ensureSupabaseSession({
      verifyUser: true,
      forceRefresh: forceRefreshOnStart,
    });
    if (!sessionRes.ok) {
      throw toEdgeInvokeError(functionName, { status: 401, message: sessionRes.error });
    }
  }

  try {
    return await invokeEdgeFunction<TResponse>(functionName, invokeOptions);
  } catch (err: any) {
    const normalized = toEdgeInvokeError(functionName, err, err?.data);
    if (!retryOnAuthError || !normalized.isAuthError) throw normalized;

    const refreshRes = await ensureSupabaseSession({
      verifyUser: true,
      forceRefresh: true,
    });
    if (!refreshRes.ok) throw normalized;

    return await invokeEdgeFunction<TResponse>(functionName, invokeOptions);
  }
}
