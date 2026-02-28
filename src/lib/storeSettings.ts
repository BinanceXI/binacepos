import { supabase } from "@/lib/supabase";
import { getTenantScopeFromLocalUser } from "@/lib/tenantScope";

type AnySettings = Record<string, any> & {
  id?: string | null;
  business_name?: string | null;
};

function isMissingBusinessName(raw: unknown) {
  const name = String(raw || "").trim();
  if (!name) return true;
  return name.toLowerCase() === "your business";
}

async function resolveBusinessNameFromTenant(businessId: string | null) {
  const id = String(businessId || "").trim();
  if (!id) return null;

  const { data, error } = await supabase
    .from("businesses")
    .select("name")
    .eq("id", id)
    .maybeSingle();

  if (error) return null;
  const name = String((data as any)?.name || "").trim();
  return name || null;
}

export async function loadStoreSettingsWithBusinessFallback(opts?: {
  businessId?: string | null;
  persist?: boolean;
}): Promise<AnySettings | null> {
  const { data, error } = await supabase.from("store_settings").select("*").maybeSingle();
  if (error && (error as any)?.code !== "PGRST116") throw error;

  const settings = ((data as AnySettings | null) || {}) as AnySettings;
  if (!isMissingBusinessName(settings.business_name)) return settings;

  const scopedBusinessId = getTenantScopeFromLocalUser()?.businessId || null;
  const businessId = String(opts?.businessId || scopedBusinessId || "").trim() || null;
  const businessName = await resolveBusinessNameFromTenant(businessId);
  if (!businessName) return settings;

  const patched: AnySettings = {
    ...settings,
    business_name: businessName,
  };

  if (opts?.persist !== false) {
    try {
      const payload = {
        ...patched,
        id: String(patched.id || "default"),
        updated_at: new Date().toISOString(),
      };
      await supabase.from("store_settings").upsert(payload);
    } catch {
      // non-fatal: fallback still applies in-memory
    }
  }

  return patched;
}
