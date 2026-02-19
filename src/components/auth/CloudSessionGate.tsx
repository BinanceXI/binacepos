import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { usePOS } from "@/contexts/POSContext";
import { clearClientIndexedDb, clearClientStorage } from "@/lib/sessionCleanup";

type CloudSessionState =
  | { status: "loading" }
  | { status: "ok"; userId: string }
  | { status: "missing"; reason: string };

async function hardLogout(setCurrentUser: (u: any) => void) {
  try {
    await supabase.auth.signOut();
  } catch {
    // ignore
  }

  // Clear local user + any persisted Supabase tokens (offline-first).
  clearClientStorage();
  await clearClientIndexedDb();

  setCurrentUser(null);
  window.location.assign("/");
}

export function CloudSessionGate({
  children,
  title = "Cloud Session Required",
}: {
  children: React.ReactNode;
  title?: string;
}) {
  const { setCurrentUser } = usePOS();
  const [state, setState] = useState<CloudSessionState>({ status: "loading" });

  useEffect(() => {
    let mounted = true;

    const refresh = async () => {
      try {
        const session = (await supabase.auth.getSession()).data.session;
        if (!session?.access_token) {
          if (!mounted) return;
          setState({ status: "missing", reason: "No active cloud session found." });
          return;
        }

        const { data, error } = await supabase.auth.getUser();
        if (error || !data?.user?.id) {
          if (!mounted) return;
          setState({ status: "missing", reason: "Cloud session expired or invalid." });
          return;
        }

        if (!mounted) return;
        setState({ status: "ok", userId: String(data.user.id) });
      } catch (e: any) {
        if (!mounted) return;
        setState({ status: "missing", reason: e?.message || "Failed to verify cloud session." });
      }
    };

    refresh();

    const { data } = supabase.auth.onAuthStateChange(() => {
      refresh();
    });

    return () => {
      mounted = false;
      data.subscription.unsubscribe();
    };
  }, [setCurrentUser]);

  const content = useMemo(() => {
    if (state.status === "loading") {
      return (
        <div className="min-h-[60vh] flex items-center justify-center p-6">
          <div className="text-sm text-muted-foreground">Checking cloud session…</div>
        </div>
      );
    }

    if (state.status === "ok") return null;

    return (
      <div className="min-h-[70vh] flex items-center justify-center p-6">
        <Card className="max-w-lg w-full shadow-card">
          <CardHeader>
            <CardTitle>{title}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="text-sm text-muted-foreground">
              You are signed in locally, but not authenticated with the cloud. Platform Admin actions (create users, billing, codes) require a valid Supabase session.
            </div>
            <div className="text-xs text-muted-foreground">
              Reason: {state.reason}
            </div>
            <div className="flex gap-2">
              <Button className="flex-1" onClick={() => hardLogout(setCurrentUser)}>
                Sign out
              </Button>
              <Button className="flex-1" variant="outline" onClick={() => window.location.assign("/")}>
                Re-authenticate
              </Button>
            </div>
            <div className="text-xs text-muted-foreground">
              Make sure you are online, then sign in again using your platform admin username and password.
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }, [state, setCurrentUser, title]);

  if (state.status === "ok") return <>{children}</>;
  return content;
}
