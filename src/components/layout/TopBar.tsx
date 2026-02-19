// File: src/components/TopBar.tsx
import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { useNavigate } from "react-router-dom";
import {
  Wifi,
  WifiOff,
  Cloud,
  CloudOff,
  User,
  LogOut,
  ChevronDown,
  Moon,
  Sun,
  MessageSquarePlus,
} from "lucide-react";
import { usePOS } from "@/contexts/POSContext";
import { supabase } from "@/lib/supabase";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { NotificationPanel } from "@/components/ui/NotificationPanel";
import { cn } from "@/lib/utils";
import { useQueryClient } from "@tanstack/react-query";
import { FeedbackDialog } from "@/components/feedback/FeedbackDialog";
import { flushFeedbackQueue, getQueuedFeedbackCount } from "@/lib/feedbackQueue";
import { demoEntryPath, isDemoEntry } from "@/lib/demoEntry";
import { clearClientIndexedDb, clearClientStorage } from "@/lib/sessionCleanup";

type PlatformAdminSessionBackup = {
  access_token: string;
  refresh_token: string;
  saved_at?: string;
};

type ImpersonationInfo = {
  audit_id: string;
  business_id: string;
  business_name?: string | null;
  role: "admin" | "cashier";
  started_at?: string;
};

const IMPERSONATION_BACKUP_KEY = "platform_admin_session_backup_v1";
const IMPERSONATION_INFO_KEY = "platform_admin_impersonation_v1";
const REACT_QUERY_PERSIST_KEY = "REACT_QUERY_OFFLINE_CACHE";
const DEMO_EXPIRES_KEY = "binancexi_demo_expires_at";

function safeJSONParse<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function safeGetItem(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export const TopBar = () => {
  const { currentUser, syncStatus, setCurrentUser, pendingSyncCount } = usePOS();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [feedbackOpen, setFeedbackOpen] = useState(false);

  const impersonationInfo = safeJSONParse<ImpersonationInfo>(
    typeof window !== "undefined" ? safeGetItem(IMPERSONATION_INFO_KEY) : null
  );
  const platformBackup = safeJSONParse<PlatformAdminSessionBackup>(
    typeof window !== "undefined" ? safeGetItem(IMPERSONATION_BACKUP_KEY) : null
  );

  const isImpersonating = Boolean(
    impersonationInfo?.audit_id &&
      platformBackup?.access_token &&
      platformBackup?.refresh_token &&
      currentUser &&
      (currentUser as any)?.role !== "platform_admin"
  );
  const [returning, setReturning] = useState(false);

  const demoExpiresAt = useMemo(() => {
    return safeGetItem(DEMO_EXPIRES_KEY);
  }, []);

  useEffect(() => {
    if (!demoExpiresAt) return;
    const ts = Date.parse(demoExpiresAt);
    if (!Number.isFinite(ts) || ts <= Date.now()) {
      try {
        localStorage.removeItem(DEMO_EXPIRES_KEY);
      } catch {
        // ignore
      }
    }
  }, [demoExpiresAt]);

  const demoBanner = useMemo(() => {
    if (!demoExpiresAt) return null;
    const ts = Date.parse(demoExpiresAt);
    if (!Number.isFinite(ts)) return null;
    const msLeft = ts - Date.now();
    if (msLeft <= 0) return null;
    return { ts, msLeft };
  }, [demoExpiresAt]);

  useEffect(() => {
    if (!currentUser) return;
    if (!navigator.onLine) return;
    if (getQueuedFeedbackCount() <= 0) return;

    // Silent best-effort flush (avoid spamming toasts).
    flushFeedbackQueue({
      currentUser: {
        id: String((currentUser as any)?.id || ""),
        business_id: String((currentUser as any)?.business_id || ""),
      },
      max: 10,
    }).catch(() => void 0);
  }, [(currentUser as any)?.id, (currentUser as any)?.business_id]);

  useEffect(() => {
    if (!currentUser) return;
    const onOnline = () => {
      if (getQueuedFeedbackCount() <= 0) return;
      flushFeedbackQueue({
        currentUser: {
          id: String((currentUser as any)?.id || ""),
          business_id: String((currentUser as any)?.business_id || ""),
        },
        max: 10,
      }).catch(() => void 0);
    };
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, [(currentUser as any)?.id, (currentUser as any)?.business_id]);

  // ✅ keep theme in sync with the DOM (no random default)
  const [isDark, setIsDark] = useState(() =>
    document.documentElement.classList.contains("dark")
  );

  useEffect(() => {
    setIsDark(document.documentElement.classList.contains("dark"));
  }, []);

  const toggleTheme = () => {
    document.documentElement.classList.toggle("dark");
    setIsDark(document.documentElement.classList.contains("dark"));
    try {
      localStorage.setItem(
        "binancexi_theme",
        document.documentElement.classList.contains("dark") ? "dark" : "light"
      );
    } catch {}
  };

  const handleLogout = async () => {
    const redirectTo = isDemoEntry() ? demoEntryPath() : "/";

    try {
      // Kill Supabase session (if online)
      await supabase.auth.signOut();
    } catch {
      // Ignore if offline / fails
    }

    // Always clear local user + scoped tenant caches (offline-first).
    clearClientStorage({ includeDemoExpires: true });
    await clearClientIndexedDb();

    setCurrentUser(null);
    queryClient.clear();

    // Force back to login route without weird double reloads
    window.location.assign(redirectTo);
  };

  const returnToPlatformAdmin = async () => {
    if (returning) return;
    if (!platformBackup?.access_token || !platformBackup?.refresh_token) {
      toast.error("Missing platform admin session backup. Please sign out and sign in again.");
      return;
    }

    setReturning(true);
    try {
      // Clear cached cross-tenant data before switching auth context.
      try {
        localStorage.removeItem(REACT_QUERY_PERSIST_KEY);
      } catch {
        // ignore
      }
      queryClient.clear();

      const { data: sess, error: sessErr } = await supabase.auth.setSession({
        access_token: platformBackup.access_token,
        refresh_token: platformBackup.refresh_token,
      });
      if (sessErr || !sess?.session?.access_token) throw sessErr || new Error("Failed to restore admin session");

      // End audit record now that we are back on platform-admin JWT.
      if (impersonationInfo?.audit_id) {
        await supabase
          .from("impersonation_audit")
          .update({ ended_at: new Date().toISOString() })
          .eq("id", impersonationInfo.audit_id);
      }

      // Load the platform admin profile and set as current user.
      const { data: u, error: uErr } = await supabase.auth.getUser();
      if (uErr || !u?.user?.id) throw uErr || new Error("Failed to load user");

      const { data: profile, error: pErr } = await supabase
        .from("profiles")
        .select("id, username, full_name, role, permissions, active, business_id")
        .eq("id", u.user.id)
        .maybeSingle();
      if (pErr || !profile) throw pErr || new Error("Failed to load profile");

      if ((profile as any)?.active === false) throw new Error("Account disabled");
      if (String((profile as any)?.role || "") !== "platform_admin") {
        throw new Error("Restored session is not platform admin");
      }

      // Clear impersonation markers after successful restore.
      try {
        localStorage.removeItem(IMPERSONATION_BACKUP_KEY);
        localStorage.removeItem(IMPERSONATION_INFO_KEY);
      } catch {
        // ignore
      }

      setCurrentUser({
        id: String((profile as any).id),
        full_name: (profile as any).full_name || (profile as any).username,
        name: (profile as any).full_name || (profile as any).username,
        username: (profile as any).username,
        role: (profile as any).role || "platform_admin",
        permissions: (profile as any).permissions || {},
        business_id: (profile as any).business_id ?? null,
        active: true,
      } as any);

      toast.success("Returned to Platform Admin");
      navigate("/platform", { replace: true });
    } catch (e: any) {
      toast.error(e?.message || "Failed to return to Platform Admin");
    } finally {
      setReturning(false);
    }
  };

  const syncDisplay = useMemo(() => {
    switch (syncStatus) {
      case "online":
        return {
          Icon: Wifi,
          label: "Online",
          pill: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
          dot: "bg-emerald-400",
          pulse: false,
        };
      case "offline":
        return {
          Icon: WifiOff,
          label: "Offline",
          pill: "bg-amber-500/10 text-amber-400 border-amber-500/20",
          dot: "bg-amber-400",
          pulse: false,
        };
      case "syncing":
        return {
          Icon: Cloud,
          label: "Syncing",
          pill: "bg-sky-500/10 text-sky-400 border-sky-500/20",
          dot: "bg-sky-400",
          pulse: true,
        };
      default:
        return {
          Icon: CloudOff,
          label: "Error",
          pill: "bg-red-500/10 text-red-400 border-red-500/20",
          dot: "bg-red-400",
          pulse: true,
        };
    }
  }, [syncStatus]);

  const displayName =
    (currentUser as any)?.full_name ||
    (currentUser as any)?.name ||
    (currentUser as any)?.username ||
    "User";

  const role = (currentUser as any)?.role || "—";

  return (
    <header
      className={cn(
        // ✅ sticky so it stays clean while scrolling
        "sticky top-0 z-40",
        isImpersonating || demoBanner ? "h-[92px] md:h-[104px]" : "h-14 md:h-16",
        "border-b border-border/70",
        "bg-background/72 backdrop-blur-xl supports-[backdrop-filter]:bg-background/58"
      )}
    >
      {isImpersonating && (
        <div className="px-3 md:px-4 pt-2">
          <div className="rounded-xl border border-amber-500/25 bg-amber-500/10 px-3 py-2 flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-xs font-semibold text-amber-200 truncate">
                Support Mode
              </div>
              <div className="text-[11px] text-muted-foreground truncate">
                {impersonationInfo?.business_name ? `Business: ${impersonationInfo.business_name}` : "Impersonating a business session"}
              </div>
            </div>
            <Button size="sm" variant="outline" disabled={returning} onClick={returnToPlatformAdmin}>
              {returning ? "Returning…" : "Return to Platform Admin"}
            </Button>
          </div>
        </div>
      )}

      {!isImpersonating && demoBanner && (
        <div className="px-3 md:px-4 pt-2">
          <div className="rounded-xl border border-sky-500/25 bg-sky-500/10 px-3 py-2 flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-xs font-semibold text-sky-200 truncate">Live Demo</div>
              <div className="text-[11px] text-muted-foreground truncate">
                {demoBanner.msLeft > 0
                  ? `Expires in ${Math.max(0, Math.ceil(demoBanner.msLeft / (60 * 60 * 1000)))}h`
                  : "Expired"}
              </div>
            </div>
            <Button size="sm" variant="outline" onClick={handleLogout}>
              End Demo
            </Button>
          </div>
        </div>
      )}

      <div className={cn("px-3 md:px-4 flex items-center justify-between gap-3", isImpersonating || demoBanner ? "h-14 md:h-16" : "h-full")}>
        {/* LEFT: Status */}
        <div className="flex items-center gap-3 min-w-0">
          <motion.div
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            className={cn(
              "flex items-center gap-2 px-3 py-1.5 rounded-full border transition-all duration-300",
              syncDisplay.pill
            )}
          >
            <span className="relative flex items-center justify-center">
              <span
                className={cn(
                  "w-2 h-2 rounded-full",
                  syncDisplay.dot,
                  syncDisplay.pulse && "animate-pulse"
                )}
              />
            </span>

            <syncDisplay.Icon className={cn("w-4 h-4", syncDisplay.pulse && "animate-pulse")} />

            <span className="text-xs font-semibold hidden sm:inline">
              {syncDisplay.label}
            </span>

            {pendingSyncCount > 0 && (
              <span className="ml-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-500/20 text-amber-200 border border-amber-500/30">
                {pendingSyncCount} queued
              </span>
            )}
          </motion.div>

          {/* optional quick hint (desktop) */}
          <div className="hidden md:block text-xs text-muted-foreground truncate">
            {syncStatus === "offline"
              ? "Working offline — sales will sync when back online."
              : syncStatus === "syncing"
              ? "Uploading offline sales…"
              : syncStatus === "error"
              ? "Sync issue — check network or sign in again."
              : "Synced."}
          </div>
        </div>

        {/* RIGHT: Actions */}
        <div className="flex items-center gap-2 md:gap-3 shrink-0">
          {/* Theme */}
          <Button
            variant="ghost"
            size="icon"
            onClick={toggleTheme}
            className="h-9 w-9 rounded-full hover:scale-[1.02] transition-transform duration-300"
            title={isDark ? "Switch to light mode" : "Switch to dark mode"}
          >
            {isDark ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
          </Button>

          {/* Notifications */}
          <NotificationPanel />

          {/* Account menu */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                className={cn(
                  "h-9 gap-2 pl-2 pr-3",
                  "hover:bg-muted/65",
                  "rounded-full transition-all duration-300 border border-transparent hover:border-border/65"
                )}
              >
                {/* Avatar */}
                <div className="w-8 h-8 rounded-full bg-primary/12 border border-primary/30 flex items-center justify-center">
                  <User className="w-4 h-4 text-primary" />
                </div>

                {/* Name/role (hide on tiny screens) */}
                <div className="text-left hidden sm:block max-w-[160px]">
                  <p className="text-sm font-semibold leading-none truncate">
                    {displayName}
                  </p>
                  <p className="text-[10px] text-muted-foreground capitalize truncate">
                    {role}
                  </p>
                </div>

                <ChevronDown className="w-4 h-4 text-muted-foreground hidden sm:block" />
              </Button>
            </DropdownMenuTrigger>

            <DropdownMenuContent align="end" className="w-60">
              <DropdownMenuLabel className="space-y-1">
                <div className="text-sm font-semibold truncate">{displayName}</div>
                <div className="text-[11px] text-muted-foreground capitalize">{role}</div>
              </DropdownMenuLabel>

              <DropdownMenuSeparator />

              <DropdownMenuItem
                className="cursor-default opacity-70"
                onSelect={(e) => e.preventDefault()}
              >
                <span className="text-xs">
                  {navigator.onLine ? "Network: Connected" : "Network: Offline"}
                </span>
              </DropdownMenuItem>

              <DropdownMenuSeparator />

              <DropdownMenuItem onClick={() => setFeedbackOpen(true)} className="cursor-pointer">
                <MessageSquarePlus className="w-4 h-4 mr-2" />
                Send Feedback
              </DropdownMenuItem>

              <DropdownMenuSeparator />

              <DropdownMenuItem
                onClick={handleLogout}
                className="text-destructive cursor-pointer focus:text-destructive"
              >
                <LogOut className="w-4 h-4 mr-2" />
                Sign Out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <FeedbackDialog open={feedbackOpen} onOpenChange={setFeedbackOpen} />
    </header>
  );
};
