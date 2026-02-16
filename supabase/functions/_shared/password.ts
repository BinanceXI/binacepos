type PasswordHash = {
  password_salt: string;
  password_hash: string;
  password_iter: number;
  password_kdf: "pbkdf2_sha256";
};

const textEncoder = new TextEncoder();

function clampInt(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function base64ToBytes(b64: string) {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function randomBytes(size: number) {
  const out = new Uint8Array(size);
  crypto.getRandomValues(out);
  return out;
}

async function pbkdf2Sha256(password: string, salt: Uint8Array, iterations: number) {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );

  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt,
      iterations,
      hash: "SHA-256",
    },
    keyMaterial,
    256
  );

  return new Uint8Array(bits);
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export function validatePassword(password: string) {
  const p = String(password || "");
  if (!p) return { ok: false as const, reason: "Password required" };
  if (p.length < 6) return { ok: false as const, reason: "Password must be at least 6 characters" };
  if (p.length > 256) return { ok: false as const, reason: "Password too long" };
  return { ok: true as const, password: p };
}

export async function hashPassword(password: string, opts: { iterations?: number } = {}): Promise<PasswordHash> {
  const iterations = clampInt(opts.iterations ?? 210_000, 120_000, 800_000);
  const salt = randomBytes(16);
  const derived = await pbkdf2Sha256(password, salt, iterations);

  return {
    password_salt: bytesToBase64(salt),
    password_hash: bytesToBase64(derived),
    password_iter: iterations,
    password_kdf: "pbkdf2_sha256",
  };
}

export async function verifyPassword(
  password: string,
  stored: Pick<PasswordHash, "password_salt" | "password_hash" | "password_iter">
) {
  const salt = base64ToBytes(stored.password_salt);
  const expected = base64ToBytes(stored.password_hash);
  const derived = await pbkdf2Sha256(
    password,
    salt,
    clampInt(stored.password_iter ?? 210_000, 120_000, 800_000)
  );
  return constantTimeEqual(expected, derived);
}

