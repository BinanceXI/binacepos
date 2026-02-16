// File: src/components/TopBar.tsx
import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
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
} from "lucide-react";
import { usePOS } from "@/contexts/POSContext";
import { supabase } from "@/lib/supabase";
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

export const TopBar = () => {
  const { currentUser, syncStatus, setCurrentUser, pendingSyncCount } = usePOS();

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
    try {
      // Kill Supabase session (if online)
      await supabase.auth.signOut();
    } catch {
      // Ignore if offline / fails
    }

    // Always clear local user (offline-first)
    try {
      localStorage.removeItem("binancexi_user");
      // clear any supabase tokens if present (safe)
      Object.keys(localStorage).forEach((k) => {
        if (k.startsWith("sb-") && k.endsWith("-auth-token")) localStorage.removeItem(k);
      });
    } catch {}

    setCurrentUser(null);

    // Force back to login route without weird double reloads
    window.location.assign("/");
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
        "h-14 md:h-16",
        "border-b border-border/70",
        "bg-background/72 backdrop-blur-xl supports-[backdrop-filter]:bg-background/58"
      )}
    >
      <div className="h-full px-3 md:px-4 flex items-center justify-between gap-3">
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
    </header>
  );
};
