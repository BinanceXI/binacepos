const MASTER_KEY_ENV = "FDMS_CRED_MASTER_KEY_B64";

function b64ToBytes(b64: string): Uint8Array {
  const raw = atob(String(b64 || "").trim());
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

function bytesToB64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

let cachedKey: CryptoKey | null = null;

async function getMasterKey() {
  if (cachedKey) return cachedKey;

  const raw = String(Deno.env.get(MASTER_KEY_ENV) || "").trim();
  if (!raw) {
    throw new Error(`${MASTER_KEY_ENV} is not set`);
  }

  const bytes = b64ToBytes(raw);
  if (bytes.length < 32) {
    throw new Error(`${MASTER_KEY_ENV} must decode to at least 32 bytes`);
  }

  cachedKey = await crypto.subtle.importKey("raw", bytes.slice(0, 32), "AES-GCM", false, ["encrypt", "decrypt"]);
  return cachedKey;
}

export async function encryptSecret(plainText: string): Promise<string> {
  const key = await getMasterKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const payload = new TextEncoder().encode(String(plainText || ""));
  const cipherBuf = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, payload);
  const cipher = new Uint8Array(cipherBuf);
  return `v1:${bytesToB64(iv)}:${bytesToB64(cipher)}`;
}

export async function decryptSecret(cipherText: string): Promise<string> {
  const raw = String(cipherText || "").trim();
  const [ver, ivB64, dataB64] = raw.split(":");
  if (ver !== "v1" || !ivB64 || !dataB64) {
    throw new Error("Invalid cipher text format");
  }

  const key = await getMasterKey();
  const iv = b64ToBytes(ivB64);
  const data = b64ToBytes(dataB64);

  const plainBuf = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, data);
  return new TextDecoder().decode(plainBuf);
}
