import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { supabase } from "@/lib/supabase";
import { toNum, type PlatformBillingSettings } from "@/lib/commercialization";
import { friendlyAdminError, requirePlatformCloudSession } from "@/lib/platformAdminUtils";

import { PlatformPageHeader } from "@/components/platform/PlatformPageHeader";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

type SettingsDraft = PlatformBillingSettings;

const DEFAULT_SETTINGS: SettingsDraft = {
  trial_days: 14,
  payment_provider: "EcoCash",
  payment_instructions:
    'Pay via EcoCash, then tap "I Have Paid" in the app to notify BinanceXI POS admin.',
  ecocash_number: null,
  ecocash_name: null,
  support_contact: null,
};

export function PlatformAdminSettingsPage() {
  const qc = useQueryClient();
  const [draft, setDraft] = useState<SettingsDraft>(DEFAULT_SETTINGS);

  const { data: settings, isFetching } = useQuery({
    queryKey: ["platform", "settings"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("platform_settings")
        .select(
          "trial_days, payment_provider, payment_instructions, ecocash_number, ecocash_name, support_contact"
        )
        .eq("id", true)
        .maybeSingle();
      if (error) throw error;
      return (data || DEFAULT_SETTINGS) as any as SettingsDraft;
    },
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    if (!settings) return;
    setDraft({
      trial_days: Math.max(1, Math.min(90, toNum(settings.trial_days, 14))),
      payment_provider: String(settings.payment_provider || "EcoCash"),
      payment_instructions: String(settings.payment_instructions || ""),
      ecocash_number: settings.ecocash_number || null,
      ecocash_name: settings.ecocash_name || null,
      support_contact: settings.support_contact || null,
    });
  }, [settings]);

  const save = async () => {
    try {
      if (!(await requirePlatformCloudSession())) return;
      const payload = {
        id: true,
        trial_days: Math.max(1, Math.min(90, toNum(draft.trial_days, 14))),
        payment_provider: String(draft.payment_provider || "EcoCash").trim() || "EcoCash",
        payment_instructions:
          String(draft.payment_instructions || "").trim() ||
          DEFAULT_SETTINGS.payment_instructions,
        ecocash_number: String(draft.ecocash_number || "").trim() || null,
        ecocash_name: String(draft.ecocash_name || "").trim() || null,
        support_contact: String(draft.support_contact || "").trim() || null,
      };

      const { error } = await supabase
        .from("platform_settings")
        .upsert(payload as any, { onConflict: "id" });
      if (error) throw error;

      toast.success("Platform settings updated");
      await qc.invalidateQueries({ queryKey: ["platform", "settings"] });
      await qc.invalidateQueries({ queryKey: ["platformSettings"] });
    } catch (e: any) {
      toast.error(friendlyAdminError(e) || "Failed to save settings");
    }
  };

  return (
    <div className="p-4 md:p-6 space-y-4">
      <PlatformPageHeader
        title="Settings"
        subtitle="Configure trial length and payment instructions shown on the activation lock screen."
        right={<Button onClick={save}>Save Settings</Button>}
      />

      <Card className="shadow-card">
        <CardHeader>
          <CardTitle>Trials & Activation</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label>Free trial length (days)</Label>
            <Input
              value={String(draft.trial_days)}
              onChange={(e) =>
                setDraft((d) => ({
                  ...d,
                  trial_days: Math.max(1, Math.min(90, toNum(e.target.value, d.trial_days))),
                }))
              }
              inputMode="numeric"
              disabled={isFetching}
            />
          </div>
          <div className="space-y-2">
            <Label>Payment provider label</Label>
            <Input
              value={draft.payment_provider}
              onChange={(e) =>
                setDraft((d) => ({ ...d, payment_provider: e.target.value }))
              }
              placeholder="EcoCash"
              disabled={isFetching}
            />
          </div>
          <div className="space-y-2">
            <Label>EcoCash number</Label>
            <Input
              value={draft.ecocash_number || ""}
              onChange={(e) =>
                setDraft((d) => ({ ...d, ecocash_number: e.target.value || null }))
              }
              placeholder="0772..."
              disabled={isFetching}
            />
          </div>
          <div className="space-y-2">
            <Label>EcoCash name</Label>
            <Input
              value={draft.ecocash_name || ""}
              onChange={(e) =>
                setDraft((d) => ({ ...d, ecocash_name: e.target.value || null }))
              }
              placeholder="Business/owner name"
              disabled={isFetching}
            />
          </div>
          <div className="space-y-2 lg:col-span-2">
            <Label>Support contact (optional)</Label>
            <Input
              value={draft.support_contact || ""}
              onChange={(e) =>
                setDraft((d) => ({ ...d, support_contact: e.target.value || null }))
              }
              placeholder="WhatsApp / phone / email"
              disabled={isFetching}
            />
          </div>
          <div className="space-y-2 lg:col-span-2">
            <Label>Payment instructions shown on lock screen</Label>
            <Textarea
              value={draft.payment_instructions}
              onChange={(e) =>
                setDraft((d) => ({ ...d, payment_instructions: e.target.value }))
              }
              rows={5}
              disabled={isFetching}
            />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export default PlatformAdminSettingsPage;
