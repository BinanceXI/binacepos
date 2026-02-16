import { Capacitor } from "@capacitor/core";

const DEVICE_ID_KEY = "binancexi_device_id_v1";
const ACTIVATION_PREFIX = "binancexi_device_activation_v1:";

function safeGetItem(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSetItem(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // ignore
  }
}

function isTauriRuntime() {
  if (typeof window === "undefined") return false;
  const w = window as any;
  const ua = String(window.navigator?.userAgent || "");
  return Boolean(w.__TAURI_INTERNALS__ || w.__TAURI__ || w.__TAURI_IPC__ || ua.includes("Tauri"));
}

export function getOrCreateDeviceId(): string {
  const existing = safeGetItem(DEVICE_ID_KEY);
  if (existing) return existing;

  // crypto.randomUUID is available in modern browsers/WebViews; keep a safe fallback.
  // @ts-ignore
  const next = globalThis.crypto?.randomUUID?.() ?? `dev-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  safeSetItem(DEVICE_ID_KEY, next);
  return next;
}

export function detectDevicePlatform(): string {
  try {
    if (Capacitor.isNativePlatform()) {
      const p = Capacitor.getPlatform();
      return p || "native";
    }
  } catch {
    // ignore
  }

  if (isTauriRuntime()) return "tauri";
  return "web";
}

export function getActivationKey(businessId: string, deviceId: string) {
  return `${ACTIVATION_PREFIX}${businessId}:${deviceId}`;
}

export function isDeviceActivatedForBusiness(businessId: string, deviceId: string): boolean {
  if (!businessId || !deviceId) return false;
  return !!safeGetItem(getActivationKey(businessId, deviceId));
}

export function markDeviceActivatedForBusiness(businessId: string, deviceId: string) {
  if (!businessId || !deviceId) return;
  safeSetItem(getActivationKey(businessId, deviceId), new Date().toISOString());
}

