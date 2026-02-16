// File: src/components/auth/LoginScreen.tsx
import { useState, useRef, useEffect } from "react";
import { motion } from "framer-motion";
import { Lock, ShieldCheck, Wifi, WifiOff, Eye, EyeOff, User } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { usePOS } from "@/contexts/POSContext";
import { supabase } from "@/lib/supabase";
import {
  sanitizeUsername,
  verifyPasswordLocal,
  callVerifyPassword,
  seedLocalUserFromPassword,
} from "@/lib/auth/offlinePasswordAuth";
import { deleteLocalUser } from "@/lib/auth/localUserStore";
import {
  detectDevicePlatform,
  getOrCreateDeviceId,
  isDeviceActivatedForBusiness,
  markDeviceActivatedForBusiness,
} from "@/lib/deviceLicense";
import { toast } from "sonner";
import { Capacitor } from "@capacitor/core";
import { NativeBiometric } from "@capgo/capacitor-native-biometric";
import { BRAND } from "@/lib/brand";
import { BrandLogo } from "@/components/brand/BrandLogo";
import { BinanceWatermark } from "@/components/brand/BinanceWatermark";

export const LoginScreen = ({ onLogin }: { onLogin: () => void }) => {
  const { setCurrentUser, syncStatus } = usePOS();

  const [username, setUsername] = useState("");
  const [secret, setSecret] = useState(""); // password
  const [showSecret, setShowSecret] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const usernameRef = useRef<HTMLInputElement>(null);
  const secretRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    usernameRef.current?.focus();
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const last = localStorage.getItem("binancexi_last_username");
        if (last) setUsername((u) => (u ? u : last));
      } catch {
        // ignore
      }
    })();
  }, []);

  const enforceDeviceLicense = async (profile: any) => {
    const role = String(profile?.role || "").trim();
    if (role === "platform_admin") return;

    const businessId = String(profile?.business_id || "").trim();
    if (!businessId) return; // SubscriptionGate will show a clearer message.

    const deviceId = getOrCreateDeviceId();

    // Offline: only allow if this device was previously activated for this business.
    if (!navigator.onLine) {
      if (!isDeviceActivatedForBusiness(businessId, deviceId)) {
        throw new Error("This device is not activated for this business. Connect online once to activate.");
      }
      return;
    }

    const session = (await supabase.auth.getSession()).data.session;
    if (!session?.access_token) {
      // We can't register without a user JWT. If already activated, allow; otherwise block.
      if (isDeviceActivatedForBusiness(businessId, deviceId)) return;
      throw new Error("Online session required to activate this device. Sign in again while online.");
    }

    const { data, error } = await supabase.rpc("register_device", {
      p_device_id: deviceId,
      p_platform: detectDevicePlatform(),
      p_label: null,
    });
    if (error) {
      // If we have prior activation for this device, allow the user to continue even if the server is flaky.
      if (isDeviceActivatedForBusiness(businessId, deviceId)) return;
      throw error;
    }

    const allowed = (data as any)?.allowed;
    if (allowed === false) {
      throw new Error("Device limit reached for this business. Ask BinanceXI POS admin to deactivate an old device.");
    }

    markDeviceActivatedForBusiness(businessId, deviceId);
  };

  const resolveProfileForAuthenticatedUser = async (fallback: { username: string; full_name?: string | null }) => {
    const {
      data: { user },
      error: userErr,
    } = await supabase.auth.getUser();

    if (userErr || !user?.id) {
      throw userErr || new Error("Online session is missing user identity");
    }

    const { data: profile, error: profileErr } = await supabase
      .from("profiles")
      .select("id, username, full_name, role, permissions, active, business_id")
      .eq("id", user.id)
      .maybeSingle();

    if (profileErr) throw profileErr;
    if (profile) return profile as any;

    throw new Error(
      "User profile not found. Ask BinanceXI POS admin to provision your account."
    );
  };

  const ensureOnlineSession = async (u: string, password: string) => {
    const existingSession = (await supabase.auth.getSession()).data.session;
    if (existingSession?.access_token) {
      const existingProfile = await resolveProfileForAuthenticatedUser({ username: u, full_name: u });
      if ((existingProfile as any)?.active === false) {
        throw new Error("Account disabled");
      }
      if (import.meta.env.DEV) {
        console.debug("[Auth] Reusing existing online session", {
          userId: existingSession.user?.id ?? null,
          username: (existingProfile as any)?.username ?? u,
        });
      }
      await seedLocalUserFromPassword(existingProfile as any, password);
      return existingProfile as any;
    }

    const verify = await callVerifyPassword(u, password);
    if (verify.ok) {
      const { data: otpData, error: otpErr } = await supabase.auth.verifyOtp({
        token_hash: verify.token_hash,
        type: verify.type,
      });
      if (otpErr) throw otpErr;

      const session = otpData?.session || (await supabase.auth.getSession()).data.session;
      if (!session?.access_token) {
        throw new Error("Failed to establish online session");
      }

      const profile = await resolveProfileForAuthenticatedUser({
        username: verify.user.username,
        full_name: verify.user.full_name,
      });
      if ((profile as any)?.active === false) {
        throw new Error("Account disabled");
      }

      if (import.meta.env.DEV) {
        console.debug("[Auth] Online session ready", {
          userId: session.user?.id ?? null,
          username: (profile as any)?.username ?? verify.user.username,
        });
      }

      await seedLocalUserFromPassword(profile as any, password);
      return profile as any;
    }

    // Fallback: first admin bootstrap flow when auth user exists but profile row does not.
    const fallbackEmail = `${u}@binancexi-pos.app`;
    const { data: signInData, error: signInErr } = await supabase.auth.signInWithPassword({
      email: fallbackEmail,
      password,
    });

    if (signInErr || !signInData?.session?.access_token) {
      const msg = "error" in verify ? String(verify.error || "") : "";
      throw new Error(msg || signInErr?.message || "Invalid credentials");
    }

    const profile = await resolveProfileForAuthenticatedUser({
      username: u,
      full_name: (signInData.user?.user_metadata?.full_name as string | undefined) || u,
    });
    if ((profile as any)?.active === false) {
      throw new Error("Account disabled");
    }

    if (import.meta.env.DEV) {
      console.debug("[Auth] Online session ready (fallback sign-in)", {
        userId: signInData.user?.id ?? null,
        username: (profile as any)?.username ?? u,
      });
    }

    await seedLocalUserFromPassword(profile as any, password);
    return profile as any;
  };

  // Fingerprint unlock: requires an existing Supabase auth session (online setup)
  const handleFingerprintLogin = async () => {
    if (!Capacitor.isNativePlatform()) {
      toast.error("Fingerprint works only on Android app");
      return;
    }

    try {
      const available = await NativeBiometric.isAvailable();
      if (!available?.isAvailable) {
        toast.error("Biometric not available on this device");
        return;
      }

      await NativeBiometric.verifyIdentity({
        reason: `Use fingerprint to access ${BRAND.name}`,
        title: "Fingerprint Login",
        subtitle: "Confirm your identity",
        description: "Scan your fingerprint",
      });

      const { data: sessionData } = await supabase.auth.getSession();
      if (!sessionData?.session?.access_token) {
        toast.error("No active session. Please sign in with your password.");
        return;
      }

      const { data: userData, error: userErr } = await supabase.auth.getUser();
      if (userErr || !userData?.user) {
        toast.error("Session expired. Please sign in with your password.");
        return;
      }

      const { data: profile, error: profErr } = await supabase
        .from("profiles")
        .select("id, username, full_name, role, permissions, active, business_id")
        .eq("id", userData.user.id)
        .maybeSingle();

      if (profErr || !profile) {
        toast.error("Failed to load profile");
        return;
      }
      if ((profile as any)?.active === false) {
        toast.error("Account disabled");
        return;
      }

      try {
        await enforceDeviceLicense(profile);
      } catch (e: any) {
        toast.error(e?.message || "Device not activated");
        return;
      }

      setCurrentUser({
        id: String((profile as any).id),
        full_name: (profile as any).full_name || (profile as any).username,
        name: (profile as any).full_name || (profile as any).username,
        username: (profile as any).username,
        role: (profile as any).role || "cashier",
        permissions: (profile as any).permissions || {},
        business_id: (profile as any).business_id ?? null,
        active: true,
      } as any);

      sessionStorage.setItem("binancexi_session_active", "1");
      toast.success(`Welcome ${(profile as any).full_name || (profile as any).username}`);
      onLogin();
    } catch (err: any) {
      toast.error(err?.message || "Fingerprint cancelled / failed");
    }
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const u = sanitizeUsername(username);
      const password = String(secret || "");

      if (!u || !password) throw new Error("Enter username and password");

      // 1) OFFLINE-FIRST: try local password verification
      const localUser = await verifyPasswordLocal(u, password);

      if (localUser) {
        let cloudUser: Awaited<ReturnType<typeof ensureOnlineSession>> | null = null;
        if (navigator.onLine) {
          try {
            cloudUser = await ensureOnlineSession(u, password);
          } catch (cloudErr: any) {
            if (import.meta.env.DEV) {
              console.warn("[Auth] Local login without cloud session", cloudErr);
            }
            toast.warning(`Signed in locally. Cloud session unavailable: ${cloudErr?.message || "Unknown error"}`);
          }
        }

        const effectiveUser = cloudUser
          ? {
              id: cloudUser.id,
              full_name: cloudUser.full_name || cloudUser.username,
              name: cloudUser.full_name || cloudUser.username,
              username: cloudUser.username,
              role: (cloudUser.role as any) || "cashier",
              permissions: cloudUser.permissions || {},
              business_id: (cloudUser as any).business_id ?? null,
            }
          : {
              id: localUser.id,
              full_name: localUser.full_name || localUser.username,
              name: localUser.full_name || localUser.username,
              username: localUser.username,
              role: (localUser.role as any) || "cashier",
              permissions: localUser.permissions || {},
              business_id: (localUser as any).business_id ?? null,
            };

        try {
          await enforceDeviceLicense(effectiveUser);
        } catch (licErr: any) {
          // If we just seeded local auth from cloud, remove it to prevent offline bypass.
          if (cloudUser) {
            try {
              await deleteLocalUser(effectiveUser.username);
            } catch {
              // ignore
            }
          }
          throw licErr;
        }

        setCurrentUser({
          ...effectiveUser,
          active: true,
        } as any);

        sessionStorage.setItem("binancexi_session_active", "1");
        localStorage.setItem("binancexi_last_username", effectiveUser.username);

        toast.success(`Welcome ${effectiveUser.full_name || effectiveUser.username}`);
        onLogin();
        return;
      }

      // 2) No local user yet:
      if (!navigator.onLine) {
        throw new Error("Offline login is not available for this user on this device. Connect once to sign in.");
      }

      // 3) Online sign-in (seed offline password hash locally)
      // Prefer edge-function username/password verification (no email required).
      const cloudUser = await ensureOnlineSession(u, password);

      try {
        await enforceDeviceLicense(cloudUser as any);
      } catch (licErr: any) {
        try {
          await deleteLocalUser(u);
        } catch {
          // ignore
        }
        // Best-effort signout so a device that isn't allowed doesn't keep a valid JWT.
        try {
          await supabase.auth.signOut();
        } catch {
          // ignore
        }
        throw licErr;
      }

      setCurrentUser({
        id: cloudUser.id,
        full_name: cloudUser.full_name || cloudUser.username,
        name: cloudUser.full_name || cloudUser.username,
        username: cloudUser.username,
        role: (cloudUser.role as any) || "cashier",
        permissions: cloudUser.permissions || {},
        business_id: (cloudUser as any).business_id ?? null,
        active: true,
      } as any);

      sessionStorage.setItem("binancexi_session_active", "1");
      localStorage.setItem("binancexi_last_username", cloudUser.username);

      toast.success(`Welcome ${cloudUser.full_name || cloudUser.username}`);
      onLogin();
      return;
    } catch (err: any) {
      setError(err?.message || "Login failed");
      toast.error(err?.message || "Login failed");
      setSecret("");
      secretRef.current?.focus();
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex bg-background">
      {/* LEFT BRAND PANEL */}
      <div className="hidden lg:flex lg:w-1/2 relative items-center justify-center overflow-hidden">
        <div className="absolute inset-0 bg-[radial-gradient(800px_420px_at_12%_-8%,rgba(25,124,188,0.6),transparent_62%),radial-gradient(860px_420px_at_112%_0%,rgba(43,174,228,0.32),transparent_60%),linear-gradient(180deg,#05253b_0%,#061624_100%)]" />
        <div className="absolute -left-16 top-24 w-56 h-56 rounded-full bg-cyan-300/20 blur-3xl" />
        <div className="absolute right-0 bottom-16 w-64 h-64 rounded-full bg-blue-400/15 blur-3xl" />

        <div className="relative z-10 flex flex-col items-center text-white px-12 w-full soft-enter">
          {/* HUGE LOGO */}
          <div className="mb-10 w-full flex justify-center">
            <BrandLogo
              className="w-[500px] max-w-full drop-shadow-[0_20px_60px_rgba(0,0,0,0.55)]"
              alt={BRAND.name}
              tone="light"
            />
          </div>

          <h1 className="text-4xl font-extrabold text-center mb-4 tracking-tight">Point of Sale + Repairs</h1>

          <p className="text-slate-200/90 text-center max-w-lg text-lg leading-relaxed">
            Sales, services, and receipts managed in one fast offline-first workspace.
          </p>

          <div className="flex gap-3 mt-8 flex-wrap justify-center">
            <StatusBadge
              ok={syncStatus === "online"}
              okLabel="Online (Synced)"
              badLabel={syncStatus === "syncing" ? "Syncing..." : "Offline Mode"}
            />
            <Tag label="Desktop Ready" />
            <Tag label="Keyboard-First" />
            <Tag label="Offline-First POS" />
          </div>

          <div className="absolute bottom-6 text-xs text-slate-300/70">© {new Date().getFullYear()} {BRAND.name}</div>
        </div>
      </div>

      {/* RIGHT LOGIN PANEL */}
      <div className="flex-1 flex items-center justify-center px-5 py-8 sm:px-6">
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.32, ease: [0.16, 1, 0.3, 1] }}
          className="w-full max-w-md space-y-6"
        >
          {/* MOBILE LOGO */}
          <div className="lg:hidden flex justify-center mb-6">
            <div className="rounded-2xl bg-gradient-to-r from-primary/15 to-accent/15 px-4 py-3 border border-primary/25 shadow-card">
              <BrandLogo className="w-[250px] max-w-full" alt={BRAND.name} />
            </div>
          </div>

          <div className="text-center">
            <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-gradient-to-br from-primary/20 to-accent/20 border border-primary/20 flex items-center justify-center shadow-sm">
              <ShieldCheck className="w-8 h-8 text-primary" />
            </div>
            <h2 className="text-3xl font-extrabold tracking-tight">Sign In</h2>
            <p className="text-muted-foreground">Enter your staff credentials</p>
          </div>

          <form onSubmit={handleLogin} className="space-y-5 rounded-2xl border border-border/90 bg-card/85 backdrop-blur-md p-5 shadow-card">
            <div className="space-y-2">
              <Label>Username</Label>
              <div className="relative">
                <User className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <Input
                  ref={usernameRef}
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="john"
                  className="pl-10 h-12 rounded-xl bg-background/75 border-border/90 focus-visible:ring-primary/50"
                  autoCapitalize="none"
                  autoCorrect="off"
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label>Password</Label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <Input
                  ref={secretRef}
                  type={showSecret ? "text" : "password"}
                  value={secret}
                  onChange={(e) => setSecret(e.target.value)}
                  placeholder="••••••••"
                  className="pl-10 pr-10 h-12 rounded-xl bg-background/75 border-border/90 focus-visible:ring-primary/50"
                  autoComplete="current-password"
                  inputMode="text"
                  enterKeyHint="done"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="absolute right-1 top-1/2 -translate-y-1/2"
                  onClick={() => setShowSecret((v) => !v)}
                >
                  {showSecret ? <EyeOff /> : <Eye />}
                </Button>
              </div>
            </div>

            {error && (
              <div className="text-sm text-red-500 bg-red-500/10 border border-red-500/20 p-3 rounded-md text-center">
                {error}
              </div>
            )}

            <Button
              type="submit"
              className="w-full h-12 text-lg rounded-xl bg-primary hover:bg-primary-hover shadow-md shadow-primary/25"
              disabled={loading}
            >
              {loading ? "Signing in..." : "Access System"}
            </Button>

            {/* Button placement */}
            <Button
              type="button"
              variant="outline"
              className="w-full h-12 rounded-xl border-primary/25 bg-background/65 hover:bg-primary/10"
              onClick={handleFingerprintLogin}
            >
              Use Fingerprint
            </Button>

            <div className="text-xs text-muted-foreground text-center">
              Offline-first sign-in uses your local password. If online, a cloud session is also created for syncing.
            </div>
          </form>
        </motion.div>
      </div>

      <BinanceWatermark className="fixed right-3 bottom-3 z-30" />
    </div>
  );
};

/* --- small helpers --- */

const Tag = ({ label }: { label: string }) => (
  <span className="px-3 py-1 text-xs rounded-full bg-white/10 border border-white/10">{label}</span>
);

const StatusBadge = ({ ok, okLabel, badLabel }: { ok: boolean; okLabel: string; badLabel: string }) => (
  <span
    className={`flex items-center gap-2 px-3 py-1 text-xs rounded-full border ${
      ok ? "bg-green-500/20 border-green-500/40 text-green-300" : "bg-amber-500/20 border-amber-500/40 text-amber-300"
    }`}
  >
    {ok ? <Wifi size={14} /> : <WifiOff size={14} />}
    {ok ? okLabel : badLabel}
  </span>
);
