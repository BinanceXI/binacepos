import { hashPassword, verifyPassword } from "@/lib/auth/passwordKdf";
import { getLocalUser, upsertLocalUser, type LocalAuthUser } from "@/lib/auth/localUserStore";

export const sanitizeUsername = (raw: string) =>
  (raw || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "");

export type RemoteUserProfile = {
  id: string;
  username: string;
  full_name: string | null;
  role: string | null;
  permissions: any;
  business_id?: string | null;
  active?: boolean | null;
};

export type VerifyPasswordResponse =
  | {
      ok: true;
      user: RemoteUserProfile;
      token_hash: string;
      type: "magiclink";
    }
  | { ok: false; error: string; details?: string };

export async function verifyPasswordLocal(username: string, password: string): Promise<LocalAuthUser | null> {
  const u = sanitizeUsername(username);
  const p = String(password || "");
  if (!u || !p) return null;

  const stored = await getLocalUser(u);
  if (!stored) return null;
  if (stored.active === false) return null;

  const ok = await verifyPassword(p, stored.password);
  return ok ? stored : null;
}

export async function seedLocalUserFromPassword(profile: RemoteUserProfile, password: string): Promise<LocalAuthUser> {
  const username = sanitizeUsername(profile.username);
  if (!username) throw new Error("Invalid username");

  const hashed = await hashPassword(password);

  const record: LocalAuthUser = {
    id: String(profile.id),
    username,
    full_name: profile.full_name ?? null,
    role: (profile.role === "platform_admin"
      ? "platform_admin"
      : profile.role === "admin"
      ? "admin"
      : "cashier") as any,
    permissions: profile.permissions || {},
    business_id: (profile as any).business_id ?? null,
    active: profile.active === false ? false : true,
    password: hashed,
    updated_at: new Date().toISOString(),
  };

  await upsertLocalUser(record);
  return record;
}

export async function callVerifyPassword(username: string, password: string): Promise<VerifyPasswordResponse> {
  const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
  const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

  if (!url || !anonKey) return { ok: false, error: "Supabase env missing" };

  const proxyEndpoint = "/functions/v1/verify_password";
  const directEndpoint = `${url.replace(/\/+$/, "")}/functions/v1/verify_password`;

  const doFetch = async (endpoint: string) => {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${anonKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ username, password }),
    });

    const data = (await res.json().catch(() => ({}))) as any;
    return { res, data };
  };

  try {
    // Prefer the Vite proxy in DEV (avoids CORS issues), but fall back to direct URL when proxy isn't configured.
    const first = import.meta.env.DEV ? proxyEndpoint : directEndpoint;
    const second = import.meta.env.DEV ? directEndpoint : null;

    let out: { res: Response; data: any };
    try {
      out = await doFetch(first);
    } catch (e) {
      if (!second) throw e;
      out = await doFetch(second);
    }

    // If the proxy is up but the function isn't found (common when proxy isn't configured),
    // retry against the direct Supabase URL.
    if (second && !out.res.ok && out.res.status === 404) {
      try {
        out = await doFetch(second);
      } catch {
        // keep the first failure
      }
    }

    const { res, data } = out;

    if (!res.ok) {
      const base = String(data?.error || `HTTP ${res.status}`);
      const hint =
        res.status === 404
          ? "verify_password edge function not found (deploy it in Supabase)."
          : "";
      const merged = hint ? `${base} — ${hint}` : base;
      return { ok: false, error: merged, details: data?.details };
    }

    return data as VerifyPasswordResponse;
  } catch (e: any) {
    return { ok: false, error: e?.message || "Failed to fetch" };
  }
}
