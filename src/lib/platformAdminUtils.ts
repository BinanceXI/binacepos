import { toast } from "sonner";
import { ensureSupabaseSession } from "@/lib/supabaseSession";

export function friendlyAdminError(e: any) {
  const status = (e as any)?.status;
  const msg = String((e as any)?.message || "");
  const lower = msg.toLowerCase();

  if (status === 404 || status === 401) {
    return "Cloud session missing. Sign out and sign in again while online.";
  }
  if (status === 403) return "Access denied.";
  if (status === 400 && lower.includes("duplicate")) {
    return "Username already exists. Choose a different username.";
  }
  if (status === 400 && lower.includes("password")) {
    return "Password does not meet policy. Use at least 6 characters.";
  }
  if (status === 400 && lower.includes("business_id")) {
    return "Business scope is missing for this request.";
  }
  if (lower.includes("missing or invalid user session")) {
    return "Cloud session missing. Sign out and sign in again while online.";
  }
  if (lower.includes("duplicate")) {
    return "Username already exists. Choose a different username.";
  }
  if (lower.includes("account disabled")) {
    return "Account disabled. Contact support.";
  }
  if (
    lower.includes("foreign key") ||
    lower.includes("constraint") ||
    lower.includes("related records")
  ) {
    return "Cannot delete because linked records exist. Deactivate instead.";
  }

  return msg || "Request failed";
}

export async function requirePlatformCloudSession() {
  const res = await ensureSupabaseSession({ verifyUser: true });
  if (res.ok) return true;
  toast.error("Cloud session missing. Sign out and sign in again while online.");
  return false;
}

export function sanitizeUsername(raw: string) {
  return String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "");
}
