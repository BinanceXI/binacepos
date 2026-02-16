// File: src/pages/SettingsPage.tsx
import { useMemo, useState, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Store,
  User as UserIcon,
  DollarSign,
  Palette,
  Database,
  ChevronRight,
  Save,
  Moon,
  Sun,
  Check,
  UserPlus,
  Edit,
  Loader2,
  Download,
  Eye,
  EyeOff,
  KeyRound,
  Search,
  Shield,
  UserCog,
  RefreshCw,
  Bell,
  LogOut,
  Trash2,
  Ban,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { usePOS } from "@/contexts/POSContext";
import { hashPassword } from "@/lib/auth/passwordKdf";
import { getLocalUser, renameLocalUser, upsertLocalUser } from "@/lib/auth/localUserStore";
import { supabase } from "@/lib/supabase";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { BrandLogo } from "@/components/brand/BrandLogo";

/* ============================
   LOCAL STORAGE KEYS (shared)
============================ */
const TAX_RATE_KEY = "binancexi_tax_rate"; // number (percentage)
const TAX_INCLUDED_KEY = "binancexi_tax_included"; // "1" | "0"
const CURRENCY_KEY = "binancexi_currency"; // "USD" | "ZWG" | "ZAR"
const LOW_STOCK_THRESHOLD_KEY = "binancexi_low_stock_threshold"; // number

/* ============================
   SECTIONS
============================ */
const settingsSections = [
  { id: "business", label: "Business Profile", icon: Store, shortcut: "1" },
  { id: "users", label: "User Management", icon: UserIcon, shortcut: "2" },
  { id: "currency", label: "Currency & Tax", icon: DollarSign, shortcut: "3" },
  { id: "appearance", label: "Appearance", icon: Palette, shortcut: "4" },
  // Security overrides/notifications are not yet enforced in the app; keep Settings clean.
  { id: "backup", label: "Backup & Export", icon: Database, shortcut: "5" },
];

/* ============================
   TYPES
============================ */
type StoreSettings = {
  id?: string;

  business_name?: string | null;
  tax_id?: string | null;
  phone?: string | null;
  email?: string | null;
  address?: string | null;

  currency?: string | null;
  tax_rate?: number | null;
  tax_included?: boolean | null;

  footer_message?: string | null;
  show_qr_code?: boolean | null;
  qr_code_data?: string | null;

  // security
  require_manager_void?: boolean | null;
  require_manager_refund?: boolean | null;
  auto_logout_minutes?: number | null;

  // notifications
  low_stock_alerts?: boolean | null;
  daily_sales_summary?: boolean | null;
  sound_effects?: boolean | null;
  low_stock_threshold?: number | null;
};

type UserPermissions = {
  allowRefunds?: boolean;
  allowVoid?: boolean;
  allowPriceEdit?: boolean;
  allowDiscount?: boolean;
  allowReports?: boolean;
  allowInventory?: boolean;
  allowSettings?: boolean;
  allowEditReceipt?: boolean;
};

const DEFAULT_PERMS: Required<UserPermissions> = {
  allowRefunds: false,
  allowVoid: false,
  allowPriceEdit: false,
  allowDiscount: false,
  allowReports: false,
  allowInventory: false,
  allowSettings: false,
  allowEditReceipt: false,
};

/* ============================
   HELPERS
============================ */
const sanitizeUsername = (raw: string) =>
  (raw || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "");

const isSelf = (currentUserId?: string, targetId?: string) =>
  !!currentUserId && !!targetId && currentUserId === targetId;

const maskPassword = (p: string) => (p ? "•".repeat(Math.min(p.length, 12)) : "");

const num = (v: any, fallback = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

function normalizeTaxRate(v: any) {
  const n = num(v, 0);
  return Math.max(0, Math.min(100, n));
}

function notifySettingsChanged() {
  // POSPage listens to this if you wired it
  window.dispatchEvent(new Event("binancexi_settings_changed"));
}

function syncSettingsToLocalStorage(s: StoreSettings) {
  localStorage.setItem(TAX_RATE_KEY, String(normalizeTaxRate(s.tax_rate ?? 0)));
  localStorage.setItem(TAX_INCLUDED_KEY, s.tax_included ? "1" : "0");
  localStorage.setItem(CURRENCY_KEY, String(s.currency || "USD"));
  localStorage.setItem(
    LOW_STOCK_THRESHOLD_KEY,
    String(Math.max(0, num(s.low_stock_threshold ?? 3, 3)))
  );
  notifySettingsChanged();
}

export const SettingsPage = () => {
  const { currentUser, setCurrentUser } = usePOS();
  const queryClient = useQueryClient();

  const isAdmin = currentUser?.role === "admin";
  const canAccessSettings =
    isAdmin || !!(currentUser as any)?.permissions?.allowSettings;

  const [isOnline, setIsOnline] = useState(() => navigator.onLine);
  const [activeSection, setActiveSection] = useState("business");
  const [isDark, setIsDark] = useState(() =>
    document.documentElement.classList.contains("dark")
  );

  // dialogs
  const [showUserDialog, setShowUserDialog] = useState(false);
  const [editingUser, setEditingUser] = useState<any>(null);
  const [showPassword, setShowPassword] = useState(false);

  // settings form
  const [formData, setFormData] = useState<StoreSettings>({});

  // staff form
  const [userForm, setUserForm] = useState<any>({
    name: "",
    username: "",
    password: "",
    role: "cashier",
    permissions: { ...DEFAULT_PERMS },
    active: true,
  });

  // quick create + search
  const [staffSearch, setStaffSearch] = useState("");
  const [quickUsername, setQuickUsername] = useState("");
  const [quickPassword, setQuickPassword] = useState("");
  const [quickRole, setQuickRole] = useState<"admin" | "cashier">("cashier");
  const [quickInventory, setQuickInventory] = useState(false);
  const [quickDiscount, setQuickDiscount] = useState(false);
  const [quickReports, setQuickReports] = useState(false);
  const [quickRefunds, setQuickRefunds] = useState(false);

  // admin self creds
  const [myUsername, setMyUsername] = useState("");
  const [myNewPassword, setMyNewPassword] = useState("");
  const [myNewPassword2, setMyNewPassword2] = useState("");
  const [savingMyCreds, setSavingMyCreds] = useState(false);

  /* ============================
     STORE SETTINGS (DB)
  ============================ */

  const { data: settings, isFetching: settingsLoading } = useQuery({
    queryKey: ["storeSettings"],
    queryFn: async () => {
      const defaults: StoreSettings = {
        business_name: "Your Business",
        currency: localStorage.getItem(CURRENCY_KEY) || "USD",
        tax_rate: num(localStorage.getItem(TAX_RATE_KEY), 0),
        tax_included: localStorage.getItem(TAX_INCLUDED_KEY) === "1",
        show_qr_code: true,
        qr_code_data: window.location.origin,

        low_stock_threshold: num(localStorage.getItem(LOW_STOCK_THRESHOLD_KEY), 3),
      };

      // Offline-first: avoid network calls when offline; use local defaults.
      if (!isOnline) {
        syncSettingsToLocalStorage(defaults);
        return defaults;
      }

      const { data, error } = await supabase.from("store_settings").select("*").maybeSingle();

      if (error && (error as any).code !== "PGRST116") throw error;

      const merged = { ...defaults, ...(data || {}) } as StoreSettings;

      // keep localStorage synced so POSPage + others behave immediately
      syncSettingsToLocalStorage(merged);
      return merged;
    },
    staleTime: 1000 * 60 * 30,
    refetchOnWindowFocus: false,
    refetchOnReconnect: true,
  });

  useEffect(() => {
    if (settings) setFormData(settings);
  }, [settings]);

  const saveSettingsMutation = useMutation({
    mutationFn: async (newSettings: StoreSettings) => {
      if (!isAdmin) throw new Error("Admins only");

      const payload: StoreSettings = {
        id: settings?.id,
        ...newSettings,
        currency: String(newSettings.currency || "USD"),
        tax_rate: normalizeTaxRate(newSettings.tax_rate ?? 0),
        tax_included: !!newSettings.tax_included,
        low_stock_threshold: Math.max(0, num(newSettings.low_stock_threshold ?? 0, 0)),
        updated_at: new Date().toISOString() as any,
      };

      // sync instantly for POS UI
      syncSettingsToLocalStorage(payload);

      // Offline-first: local settings still apply; cloud sync requires internet.
      if (!isOnline) return { savedOffline: true as const };

      const { error } = await supabase.from("store_settings").upsert(payload);
      if (error) throw error;
      return { savedOffline: false as const };
    },
    onSuccess: async (res) => {
      await queryClient.invalidateQueries({ queryKey: ["storeSettings"] });
      toast.success(res?.savedOffline ? "Saved locally (offline)" : "Settings saved");
    },
    onError: (err: any) => toast.error(err?.message || "Save failed"),
  });

  /* ============================
     USERS (DB)
  ============================ */

  const { data: users = [], isFetching: usersLoading } = useQuery({
    queryKey: ["profiles"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("profiles")
        .select("id, username, full_name, role, permissions, active")
        .order("role")
        .order("full_name");
      if (error) throw error;
      return data || [];
    },
    enabled: isAdmin && isOnline,
    staleTime: 1000 * 10,
    refetchOnWindowFocus: false,
  });

  const filteredUsers = useMemo(() => {
    const q = staffSearch.trim().toLowerCase();
    if (!q) return users;
    return users.filter((u: any) => {
      const n = String(u.full_name || "").toLowerCase();
      const un = String(u.username || "").toLowerCase();
      const r = String(u.role || "").toLowerCase();
      return n.includes(q) || un.includes(q) || r.includes(q);
    });
  }, [users, staffSearch]);

  useEffect(() => {
    const loadMe = async () => {
      if (!currentUser?.id) return;
      if (!isOnline) return;
      const { data } = await supabase
        .from("profiles")
        .select("username")
        .eq("id", currentUser.id)
        .maybeSingle();
      if (data?.username) setMyUsername(String(data.username));
    };
    loadMe();
  }, [currentUser?.id, isOnline]);

  /* ============================
     DELETE / DEACTIVATE USER
     - Delete via Edge Function (auth + profile)
     - Deactivate fallback (safe if FK blocks delete)
  ============================ */

  const deactivateUserMutation = useMutation({
    mutationFn: async (user: any) => {
      if (!isAdmin) throw new Error("Admins only");
      if (!isOnline) throw new Error("You are offline");

      if (isSelf(currentUser?.id, user.id)) {
        throw new Error("You cannot deactivate your own account");
      }

      const { error } = await supabase
        .from("profiles")
        .update({ active: false })
        .eq("id", user.id);

      if (error) throw error;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["profiles"] });
      toast.success("User deactivated");
    },
    onError: (e: any) => toast.error(e?.message || "Deactivate failed"),
  });

  const activateUserMutation = useMutation({
    mutationFn: async (user: any) => {
      if (!isAdmin) throw new Error("Admins only");
      if (!isOnline) throw new Error("You are offline");

      if (isSelf(currentUser?.id, user.id)) {
        throw new Error("You cannot activate your own account");
      }

      const { error } = await supabase
        .from("profiles")
        .update({ active: true })
        .eq("id", user.id);

      if (error) throw error;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["profiles"] });
      toast.success("User activated");
    },
    onError: (e: any) => toast.error(e?.message || "Activate failed"),
  });

  const deleteUserMutation = useMutation({
    mutationFn: async (user: any) => {
      if (!isAdmin) throw new Error("Admins only");
      if (!isOnline) throw new Error("You are offline");

      if (isSelf(currentUser?.id, user.id)) {
        throw new Error("You cannot delete your own account");
      }

      // Call Edge Function (must exist + deployed)
      const { data, error } = await supabase.functions.invoke("delete_staff_user", {
        body: { user_id: user.id },
      });

      if (error) throw error;
      if ((data as any)?.error) throw new Error((data as any).error);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["profiles"] });
      toast.success("User deleted");
    },
    onError: (e: any) => {
      // If delete fails (often due to FK refs from orders), guide to deactivate instead.
      toast.error(e?.message || "Delete failed");
    },
  });

  /* ============================
     CREATE / EDIT USER
  ============================ */

  const saveUserMutation = useMutation({
    mutationFn: async (data: any) => {
      if (!isAdmin) throw new Error("Admins only");
      if (!isOnline) throw new Error("You are offline. Connect to manage users.");

      const permissions: UserPermissions = {
        ...DEFAULT_PERMS,
        ...(data.permissions || {}),
      };

      // EDIT
      if (editingUser) {
        const full_name = String(data.name || "").trim();
        if (!full_name) throw new Error("Full name required");

        const nextRole = (data.role || "cashier") as "admin" | "cashier";
        const nextUsername = sanitizeUsername(data.username || editingUser.username || "");
        if (nextUsername && nextUsername.length < 3) throw new Error("Username must be 3+ characters");

        const nextPerms =
          nextRole === "admin"
            ? {
                ...DEFAULT_PERMS,
                allowRefunds: true,
                allowVoid: true,
                allowPriceEdit: true,
                allowDiscount: true,
                allowReports: true,
                allowInventory: true,
                allowSettings: true,
                allowEditReceipt: true,
              }
            : { ...DEFAULT_PERMS, ...permissions };

        const { error } = await supabase
          .from("profiles")
          .update({
            full_name,
            role: nextRole,
            username: nextUsername || null,
            permissions: nextPerms,
            active: data.active === false ? false : true,
          })
          .eq("id", editingUser.id);

        if (error) throw error;

        // Optional: password reset via Edge Function (hashed server-side)
        const nextPassword = String(data.password || "").trim();
        if (nextPassword.length >= 6) {
          const { data: fnData, error: fnErr } = await supabase.functions.invoke(
            "set_staff_password",
            { body: { user_id: editingUser.id, password: nextPassword } }
          );
          if (fnErr) throw fnErr;
          if ((fnData as any)?.error) throw new Error((fnData as any).error);
        }

        return;
      }

      // CREATE
      const full_name = String(data.name || "").trim();
      const username = sanitizeUsername(data.username);
      const password = String(data.password || "");

      if (!full_name) throw new Error("Full name required");
      if (!username) throw new Error("Username required");
      if (username.length < 3) throw new Error("Username must be 3+ characters");
      if (password.length < 6) throw new Error("Password must be at least 6 characters");

      const role = (data.role || "cashier") as "admin" | "cashier";
      const perms =
        role === "admin"
          ? {
              ...DEFAULT_PERMS,
              allowRefunds: true,
              allowVoid: true,
              allowPriceEdit: true,
              allowDiscount: true,
              allowReports: true,
              allowInventory: true,
              allowSettings: true,
              allowEditReceipt: true,
            }
          : { ...DEFAULT_PERMS, ...permissions };

      const { data: fnData, error: fnErr } = await supabase.functions.invoke(
        "create_staff_user",
        {
          body: {
            username,
            password,
            full_name,
            role,
            permissions: perms,
          },
        }
      );

      if (fnErr) throw fnErr;
      if ((fnData as any)?.error) throw new Error((fnData as any).error);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["profiles"] });
      toast.success(editingUser ? "User updated" : "User created");
      setShowUserDialog(false);
      setEditingUser(null);
      setUserForm({
        name: "",
        username: "",
        password: "",
        role: "cashier",
        permissions: { ...DEFAULT_PERMS },
        active: true,
      });
    },
    onError: (err: any) => toast.error(err?.message || "User save failed"),
  });

  const quickCreateMutation = useMutation({
    mutationFn: async () => {
      if (!isAdmin) throw new Error("Admins only");
      if (!isOnline) throw new Error("You are offline");

      const username = sanitizeUsername(quickUsername);
      const password = String(quickPassword || "").trim() || `${username}123`;
      if (!username) throw new Error("Username required");
      if (username.length < 3) throw new Error("Username must be 3+ characters");
      if (password.length < 6) throw new Error("Password must be at least 6 characters");
      const full_name = username
        .replace(/[._-]/g, " ")
        .replace(/\b\w/g, (m) => m.toUpperCase());

      const role = quickRole;

      const perms: UserPermissions =
        role === "admin"
          ? {
              ...DEFAULT_PERMS,
              allowRefunds: true,
              allowVoid: true,
              allowPriceEdit: true,
              allowDiscount: true,
              allowReports: true,
              allowInventory: true,
              allowSettings: true,
              allowEditReceipt: true,
            }
          : {
              ...DEFAULT_PERMS,
              allowInventory: !!quickInventory,
              allowDiscount: !!quickDiscount,
              allowReports: !!quickReports,
              allowRefunds: !!quickRefunds,
            };

      const { data: fnData, error: fnErr } = await supabase.functions.invoke(
        "create_staff_user",
        {
          body: {
            username,
            password,
            full_name,
            role,
            permissions: perms,
          },
        }
      );

      if (fnErr) throw fnErr;
      if ((fnData as any)?.error) throw new Error((fnData as any).error);

      return { username, password };
    },
    onSuccess: async (res) => {
      await queryClient.invalidateQueries({ queryKey: ["profiles"] });
      toast.success(`Created @${res.username}`);
      toast.message(`Default password: ${res.password}`, {
        description: "Share this with the staff user, then ask them to change it.",
      });
      setQuickUsername("");
      setQuickPassword("");
      setQuickRole("cashier");
      setQuickInventory(false);
      setQuickDiscount(false);
      setQuickReports(false);
      setQuickRefunds(false);
    },
    onError: (e: any) => toast.error(e?.message || "Failed"),
  });

  /* ============================
     ADMIN SELF CREDS
  ============================ */
  const saveMyCredentials = async () => {
    if (!isAdmin || !currentUser?.id) return toast.error("Admins only");
    if (!isOnline) return toast.error("You are offline");

    const nextUsername = sanitizeUsername(myUsername);
    if (nextUsername.length < 3) return toast.error("Username must be 3+ characters");

    if (myNewPassword || myNewPassword2) {
      if (myNewPassword.length < 6) return toast.error("Password must be 6+");
      if (myNewPassword !== myNewPassword2) return toast.error("Passwords do not match");
    }

    setSavingMyCreds(true);
    try {
      const prevUsername = sanitizeUsername((currentUser as any)?.username || "");
      const { error: profErr } = await supabase
        .from("profiles")
        .update({ username: nextUsername })
        .eq("id", currentUser.id);
      if (profErr) throw profErr;

      // Rename local offline user record if present (so password updates write to the right key)
      if (prevUsername && prevUsername !== nextUsername) {
        await renameLocalUser(prevUsername, nextUsername);
      }

      if (myNewPassword) {
        const { data: fnData, error: fnErr } = await supabase.functions.invoke("set_staff_password", {
          body: { user_id: currentUser.id, password: myNewPassword },
        });
        if (fnErr) throw fnErr;
        if ((fnData as any)?.error) throw new Error((fnData as any).error);

        // Keep OFFLINE password login in sync for this device
        const hashed = await hashPassword(myNewPassword);
        const local = await getLocalUser(nextUsername);
        await upsertLocalUser({
          id: currentUser.id,
          username: nextUsername,
          full_name:
            (local?.full_name as any) ??
            (currentUser as any)?.full_name ??
            (currentUser as any)?.name ??
            null,
          role: ((currentUser as any)?.role === "admin" ? "admin" : "cashier") as any,
          permissions: (currentUser as any)?.permissions || {},
          active: true,
          password: hashed,
          updated_at: new Date().toISOString(),
        });
      }

      // Keep local session in sync (username changes affect UI + login)
      setCurrentUser({ ...(currentUser as any), username: nextUsername } as any);
      localStorage.setItem("binancexi_last_username", nextUsername);

      setMyNewPassword("");
      setMyNewPassword2("");
      toast.success("Admin credentials updated");
      await queryClient.invalidateQueries({ queryKey: ["profiles"] });
    } catch (e: any) {
      toast.error(e?.message || "Failed to update credentials");
    } finally {
      setSavingMyCreds(false);
    }
  };

  /* ============================
     SHORTCUTS + THEME
  ============================ */
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    const tag = (document.activeElement?.tagName || "").toUpperCase();
    if (tag === "INPUT" || tag === "TEXTAREA") return;

    if (e.key >= "1" && e.key <= "9") {
      const index = parseInt(e.key, 10) - 1;
      const sec = settingsSections[index];
      if (sec) setActiveSection(sec.id);
    }
  }, []);

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  useEffect(() => {
    const onOn = () => setIsOnline(true);
    const onOff = () => setIsOnline(false);
    window.addEventListener("online", onOn);
    window.addEventListener("offline", onOff);
    return () => {
      window.removeEventListener("online", onOn);
      window.removeEventListener("offline", onOff);
    };
  }, []);

  const toggleTheme = () => {
    setIsDark((v) => !v);
    document.documentElement.classList.toggle("dark");
  };

  /* ============================
     EXPORT BACKUP
  ============================ */
  const handleExportData = async () => {
    if (!isAdmin) return toast.error("Admins only");
    if (!isOnline) return toast.error("You are offline. Connect to export a backup.");

      toast.loading("Generating backup...");
      try {
        const [products, orders, items, profiles, storeSettings] = await Promise.all([
          supabase.from("products").select("*"),
          supabase.from("orders").select("*"),
          supabase.from("order_items").select("*"),
          supabase.from("profiles").select("id, username, full_name, role, permissions, active"),
          supabase.from("store_settings").select("*").maybeSingle(),
        ]);

      const backup = {
        timestamp: new Date().toISOString(),
        settings: storeSettings.data || formData,
        products: products.data || [],
        orders: orders.data || [],
        order_items: items.data || [],
        profiles: profiles.data || [],
      };

      const blob = new Blob([JSON.stringify(backup, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);

      const a = document.createElement("a");
      a.href = url;
      a.download = `binancexi-backup-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();

      toast.dismiss();
      toast.success("Backup downloaded");
    } catch (e: any) {
      toast.dismiss();
      toast.error(e?.message || "Backup failed");
    }
  };

  /* ============================
     USER DIALOG HELPERS
  ============================ */
  const openUserEdit = (user: any) => {
    setEditingUser(user);
    setUserForm({
      name: user.full_name || "",
      role: user.role || "cashier",
      permissions: { ...DEFAULT_PERMS, ...(user.permissions || {}) },
      // Never read/store password hashes from DB on the client.
      username: user.username || "",
      password: "",
      active: user.active !== false,
    });
    setShowUserDialog(true);
  };

  const handleAddUser = () => {
    setEditingUser(null);
    setUserForm({
      name: "",
      username: "",
      password: "",
      role: "cashier",
      permissions: { ...DEFAULT_PERMS },
      active: true,
    });
    setShowUserDialog(true);
  };

  const handlePermissionToggle = (key: keyof UserPermissions) => {
    setUserForm((prev: any) => ({
      ...prev,
      permissions: {
        ...(prev.permissions || {}),
        [key]: !prev.permissions?.[key],
      },
    }));
  };

  /* ============================
     LOGOUT
  ============================ */
  const logout = async () => {
    try {
      setCurrentUser(null);
      await supabase.auth.signOut();
    } catch {
      setCurrentUser(null);
    }
  };

  /* ============================
     ACCESS GUARD
  ============================ */
  if (!currentUser) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-slate-950">
        <Card className="max-w-md w-full">
          <CardHeader>
            <CardTitle>Not logged in</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            Please login to access settings.
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!canAccessSettings) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-slate-950">
        <Card className="max-w-md w-full">
          <CardHeader>
            <CardTitle>Access denied</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            Your account does not have permission to open Settings.
          </CardContent>
        </Card>
      </div>
    );
  }

  /* ============================
     UI
  ============================ */
  return (
    <div className="flex flex-col lg:flex-row h-full gap-4 p-3 md:p-6 bg-slate-50 dark:bg-slate-950 min-h-screen">
      {/* Sidebar (sticky on desktop) */}
      <div className="w-full lg:w-72 shrink-0">
        <div className="lg:sticky lg:top-6 lg:h-[calc(100vh-3rem)] lg:overflow-y-auto rounded-2xl bg-white/60 dark:bg-slate-900/40 border border-slate-200 dark:border-slate-800 p-3">
          {/* Header */}
          <div className="flex items-center gap-3 px-1 mb-3">
            <BrandLogo className="text-xl" alt="BinanceXI POS" />
            <div className="leading-tight min-w-0">
              <div className="text-base font-bold text-slate-900 dark:text-white truncate">
                Settings
              </div>
              <div className="text-[11px] text-slate-500 dark:text-slate-400 truncate">
                {(currentUser as any)?.full_name ||
                  (currentUser as any)?.name ||
                  (currentUser as any)?.username ||
                  "User"}{" "}
                • {(currentUser as any)?.role || "—"}
              </div>
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="ml-auto"
              onClick={logout}
              title="Logout"
            >
              <LogOut className="w-4 h-4" />
            </Button>
          </div>

          {/* Mobile: horizontal section bar */}
          <div className="flex lg:hidden gap-2 overflow-x-auto pb-2 no-scrollbar">
            {settingsSections.map((section) => (
              <button
                key={section.id}
                onClick={() => setActiveSection(section.id)}
                className={cn(
                  "px-3 py-2 rounded-xl border text-xs font-medium whitespace-nowrap",
                  activeSection === section.id
                    ? "bg-blue-600 text-white border-blue-600"
                    : "bg-white/70 dark:bg-slate-950/40 text-slate-700 dark:text-slate-200 border-slate-200 dark:border-slate-800"
                )}
                type="button"
              >
                {section.label}
              </button>
            ))}
          </div>

          {/* Desktop: vertical nav */}
          <div className="hidden lg:flex flex-col gap-2">
            {settingsSections.map((section) => (
              <button
                key={section.id}
                onClick={() => setActiveSection(section.id)}
                className={cn(
                  "w-full flex items-center gap-3 px-4 py-3 rounded-xl text-left transition-all",
                  activeSection === section.id
                    ? "bg-blue-600 text-white shadow-lg shadow-blue-500/20"
                    : "hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300"
                )}
                type="button"
              >
                <span className="text-[10px] font-mono opacity-70 w-6 border border-current rounded text-center">
                  {section.shortcut}
                </span>
                <section.icon className="w-5 h-5" />
                <span className="font-medium">{section.label}</span>
                {activeSection === section.id && (
                  <ChevronRight className="w-4 h-4 ml-auto" />
                )}
              </button>
            ))}
          </div>

          {/* Quick status */}
          <div className="mt-3 px-2 text-[11px] text-slate-500 dark:text-slate-400">
            {settingsLoading ? "Loading settings…" : "Settings synced"}
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 max-w-4xl w-full">
        <AnimatePresence mode="wait">
          {/* BUSINESS */}
          {activeSection === "business" && (
            <motion.div
              key="business"
              initial={{ opacity: 0, x: 12 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0 }}
              className="space-y-4"
            >
              <Card>
                <CardHeader>
                  <CardTitle>Business Profile</CardTitle>
                </CardHeader>

                <CardContent className="space-y-4">
                  <div className="flex items-center gap-4 p-4 bg-muted/30 rounded-xl border border-border">
                    <BrandLogo className="text-2xl" alt="BinanceXI POS" />
                    <div className="min-w-0">
                      <h3 className="font-bold text-lg truncate">
                        {formData.business_name || "Your Business"}
                      </h3>
                      <p className="text-sm text-muted-foreground">
                        System configuration
                      </p>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <Field label="Business Name">
                      <Input
                        value={formData.business_name || ""}
                        onChange={(e) =>
                          setFormData({ ...formData, business_name: e.target.value })
                        }
                        disabled={!isAdmin}
                      />
                    </Field>

                    <Field label="Tax ID / ZIMRA">
                      <Input
                        value={formData.tax_id || ""}
                        onChange={(e) =>
                          setFormData({ ...formData, tax_id: e.target.value })
                        }
                        disabled={!isAdmin}
                      />
                    </Field>

                    <Field label="Phone">
                      <Input
                        value={formData.phone || ""}
                        onChange={(e) =>
                          setFormData({ ...formData, phone: e.target.value })
                        }
                        disabled={!isAdmin}
                      />
                    </Field>

                    <Field label="Email">
                      <Input
                        value={formData.email || ""}
                        onChange={(e) =>
                          setFormData({ ...formData, email: e.target.value })
                        }
                        disabled={!isAdmin}
                      />
                    </Field>

                    <Field label="Address" full>
                      <Input
                        value={formData.address || ""}
                        onChange={(e) =>
                          setFormData({ ...formData, address: e.target.value })
                        }
                        disabled={!isAdmin}
                      />
                    </Field>

                    <Field label="Receipt Footer Message" full>
                      <Input
                        value={formData.footer_message || ""}
                        onChange={(e) =>
                          setFormData({ ...formData, footer_message: e.target.value })
                        }
                        disabled={!isAdmin}
                        placeholder="Thank you for your business!"
                      />
                    </Field>

                    <div className="flex items-center justify-between p-4 rounded-lg bg-muted/50 md:col-span-2">
                      <div>
                        <p className="font-medium">Show QR Code on Receipts</p>
                        <p className="text-xs text-muted-foreground">
                          QR code can open verify page.
                        </p>
                      </div>
                      <Switch
                        checked={formData.show_qr_code !== false}
                        onCheckedChange={(c) =>
                          setFormData({ ...formData, show_qr_code: c })
                        }
                        disabled={!isAdmin}
                      />
                    </div>

                    <Field label="QR Code Base URL" full>
                      <Input
                        value={formData.qr_code_data || ""}
                        onChange={(e) =>
                          setFormData({ ...formData, qr_code_data: e.target.value })
                        }
                        disabled={!isAdmin}
                        placeholder={window.location.origin}
                      />
                    </Field>
                  </div>
                </CardContent>
              </Card>

              {isAdmin && (
                <div className="flex justify-end">
                  <Button
                    size="lg"
                    className="bg-primary hover:bg-blue-600 gap-2"
                    onClick={() => saveSettingsMutation.mutate(formData)}
                    disabled={saveSettingsMutation.isPending}
                  >
                    {saveSettingsMutation.isPending ? (
                      <Loader2 className="animate-spin" />
                    ) : (
                      <Save className="w-4 h-4" />
                    )}
                    Save Business Settings
                  </Button>
                </div>
              )}
            </motion.div>
          )}

          {/* USERS */}
          {activeSection === "users" && (
            <motion.div
              key="users"
              initial={{ opacity: 0, x: 12 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0 }}
              className="space-y-4"
            >
              {!isAdmin ? (
                <Card>
                  <CardContent className="p-6 text-sm text-muted-foreground">
                    Admins only.
                  </CardContent>
                </Card>
              ) : (
                <>
                  <Card className="border-primary/20">
                    <CardHeader className="flex flex-row items-center justify-between">
                      <CardTitle className="flex items-center gap-2">
                        <UserCog className="w-5 h-5" />
                        Quick Create Staff
                      </CardTitle>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          queryClient.invalidateQueries({ queryKey: ["profiles"] })
                        }
                        className="gap-2"
                      >
                        <RefreshCw className="w-4 h-4" /> Refresh
                      </Button>
                    </CardHeader>

                    <CardContent className="space-y-4">
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <Field label="Username">
                          <Input
                            value={quickUsername}
                            onChange={(e) => setQuickUsername(e.target.value)}
                            placeholder="e.g. john"
                          />
                          <div className="text-[11px] text-muted-foreground mt-1">
                            Default password:{" "}
                            <span className="font-mono">
                              {sanitizeUsername(quickUsername) || "username"}123
                            </span>
                          </div>
                        </Field>

                        <Field label="Password">
                          <Input
                            type="password"
                            value={quickPassword}
                            onChange={(e) => setQuickPassword(e.target.value)}
                            placeholder={`${sanitizeUsername(quickUsername) || "username"}123`}
                          />
                          <div className="text-[11px] text-muted-foreground mt-1">
                            Leave blank to use the default password shown.
                          </div>
                        </Field>

                        <Field label="Role">
                          <Select
                            value={quickRole}
                            onValueChange={(v) =>
                              setQuickRole(v as "admin" | "cashier")
                            }
                          >
                            <SelectTrigger>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="admin">Admin</SelectItem>
                              <SelectItem value="cashier">Staff</SelectItem>
                            </SelectContent>
                          </Select>
                        </Field>

                        <Field label="Quick Permissions">
                          <div className="flex flex-col gap-2 p-3 rounded-xl bg-muted/40 border border-border">
                            <ToggleRow label="Inventory" value={quickInventory} onChange={setQuickInventory} />
                            <ToggleRow label="Discounts" value={quickDiscount} onChange={setQuickDiscount} />
                            <ToggleRow label="Reports" value={quickReports} onChange={setQuickReports} />
                            <ToggleRow label="Refunds" value={quickRefunds} onChange={setQuickRefunds} />
                          </div>
                        </Field>
                      </div>

                      <div className="flex items-center justify-between gap-3 flex-wrap">
                        <div className="inline-flex items-center gap-2 text-xs text-muted-foreground">
                          <Shield className="w-4 h-4" />
                          Fast create for real-world POS use.
                        </div>
	                        <Button
	                          className="gap-2"
	                          onClick={() => quickCreateMutation.mutate()}
	                          disabled={quickCreateMutation.isPending || !isOnline}
	                        >
                          {quickCreateMutation.isPending ? (
                            <Loader2 className="animate-spin" />
                          ) : (
                            <UserPlus className="w-4 h-4" />
                          )}
	                          Create Staff
	                        </Button>
	                        {!isOnline && (
	                          <div className="text-xs text-muted-foreground">
	                            Offline: connect to create staff.
	                          </div>
	                        )}
	                      </div>
                    </CardContent>
                  </Card>

                  <Card>
                    <CardHeader>
                      <CardTitle className="flex items-center gap-2">
                        <KeyRound className="w-5 h-5" />
                        My Admin Account
                      </CardTitle>
                    </CardHeader>

                    <CardContent className="space-y-4">
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <Field label="Username">
                          <Input
                            value={myUsername}
                            onChange={(e) => setMyUsername(e.target.value)}
                            placeholder="admin"
                          />
                        </Field>

                        <Field label="New Password">
                          <Input
                            type="password"
                            value={myNewPassword}
                            onChange={(e) => setMyNewPassword(e.target.value)}
                            placeholder={maskPassword("password")}
                          />
                        </Field>

                        <Field label="Confirm New Password" full>
                          <Input
                            type="password"
                            value={myNewPassword2}
                            onChange={(e) => setMyNewPassword2(e.target.value)}
                            placeholder={maskPassword("password")}
                          />
                        </Field>
                      </div>

                      <div className="flex justify-end">
                        <Button onClick={saveMyCredentials} disabled={savingMyCreds}>
  {savingMyCreds ? <Loader2 className="animate-spin" /> : "Save My Changes"}
</Button>
                      </div>
                    </CardContent>
                  </Card>

                  <Card>
                    <CardHeader className="flex flex-row items-center justify-between">
                      <CardTitle>Staff</CardTitle>
                      <div className="flex items-center gap-2">
                        <div className="relative">
                          <Search className="w-4 h-4 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
                          <Input
                            className="pl-8 h-9 w-44 md:w-56"
                            placeholder="Search staff…"
                            value={staffSearch}
                            onChange={(e) => setStaffSearch(e.target.value)}
                          />
                        </div>
	                        <Button size="sm" className="gap-2" onClick={handleAddUser} disabled={!isOnline}>
	                          <UserPlus className="w-4 h-4" /> Add
	                        </Button>
                      </div>
                    </CardHeader>

                    <CardContent className="space-y-3">
                                          {usersLoading ? (
                        <div className="flex items-center gap-2 text-sm text-muted-foreground">
                          <Loader2 className="animate-spin" /> Loading…
                        </div>
                      ) : filteredUsers.length === 0 ? (
                        <div className="text-sm text-muted-foreground">
                          No staff found.
                        </div>
                      ) : (
                        filteredUsers.map((user: any) => {
                          const active = user.active !== false;
                          const badgeVariant =
                            user.role === "admin" ? "default" : "secondary";

                          return (
                            <div
                              key={user.id}
                              className={cn(
                                "flex items-center justify-between p-4 rounded-xl bg-card border border-border transition-colors",
                                !active && "opacity-70"
                              )}
                            >
                              <div className="flex items-center gap-4 min-w-0">
                                <div
                                  className={cn(
                                    "w-10 h-10 rounded-full flex items-center justify-center font-bold shrink-0",
                                    user.role === "admin"
                                      ? "bg-blue-600/15 text-blue-600"
                                      : "bg-primary/10 text-primary"
                                  )}
                                  title={active ? "Active" : "Deactivated"}
                                >
                                  {(user.full_name || user.username || "U")
                                    .charAt(0)
                                    .toUpperCase()}
                                </div>

                                <div className="min-w-0">
                                  <div className="flex items-center gap-2 flex-wrap">
                                    <span className="font-semibold truncate max-w-[220px]">
                                      {user.full_name || "Unnamed"}
                                    </span>
                                    <Badge variant={badgeVariant}>
                                      {String(user.role || "cashier")}
                                    </Badge>
                                    {!active && (
                                      <Badge variant="outline" className="text-amber-600 border-amber-600/30">
                                        Deactivated
                                      </Badge>
                                    )}
                                    {user.username && (
                                      <span className="text-[11px] text-muted-foreground font-mono truncate">
                                        @{user.username}
                                      </span>
                                    )}
                                  </div>

                                  <div className="text-[11px] text-muted-foreground mt-1">
                                    {(user.permissions?.allowInventory ? "Inventory" : "—")} •{" "}
                                    {(user.permissions?.allowDiscount ? "Discounts" : "—")} •{" "}
                                    {(user.permissions?.allowReports ? "Reports" : "—")} •{" "}
                                    {(user.permissions?.allowRefunds ? "Refunds" : "—")} •{" "}
                                    {(user.permissions?.allowVoid ? "Void" : "—")} •{" "}
                                    {(user.permissions?.allowSettings ? "Settings" : "—")}
                                  </div>
                                </div>
                              </div>

                              <div className="flex items-center gap-1 shrink-0">
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  onClick={() => openUserEdit(user)}
                                  title="Edit user"
                                >
                                  <Edit className="w-4 h-4" />
                                </Button>

                                {!isSelf(currentUser?.id, user.id) && (
                                  <>
                                    {/* Deactivate / Activate */}
                                    <Button
                                      variant="ghost"
                                      size="icon"
                                      className={cn(
                                        "text-amber-600 hover:text-amber-700",
                                        !active && "text-emerald-600 hover:text-emerald-700"
                                      )}
                                      title={active ? "Deactivate user" : "Activate user"}
                                      disabled={
                                        deactivateUserMutation.isPending || activateUserMutation.isPending
                                      }
                                      onClick={() => {
                                        if (active) {
                                          if (
                                            confirm(
                                              `Deactivate ${user.full_name || user.username || "this user"}? They will not be able to login.`
                                            )
                                          ) {
                                            deactivateUserMutation.mutate(user);
                                          }
                                        } else {
                                          if (
                                            confirm(
                                              `Activate ${user.full_name || user.username || "this user"}? They will be able to login again.`
                                            )
                                          ) {
                                            activateUserMutation.mutate(user);
                                          }
                                        }
                                      }}
                                    >
                                      {deactivateUserMutation.isPending || activateUserMutation.isPending ? (
                                        <Loader2 className="w-4 h-4 animate-spin" />
                                      ) : active ? (
                                        <Ban className="w-4 h-4" />
                                      ) : (
                                        <Check className="w-4 h-4" />
                                      )}
                                    </Button>

                                    {/* Hard delete (Edge Function) */}
                                    <Button
                                      variant="ghost"
                                      size="icon"
                                      className="text-red-600 hover:text-red-700"
                                      title="Delete user (permanent)"
                                      disabled={deleteUserMutation.isPending}
                                      onClick={() => {
                                        if (
                                          confirm(
                                            `Delete ${user.full_name || user.username || "this user"}?\n\nThis is permanent and may fail if they have sales history.\nIf it fails, deactivate instead.`
                                          )
                                        ) {
                                          deleteUserMutation.mutate(user);
                                        }
                                      }}
                                    >
                                      {deleteUserMutation.isPending ? (
                                        <Loader2 className="w-4 h-4 animate-spin" />
                                      ) : (
                                        <Trash2 className="w-4 h-4" />
                                      )}
                                    </Button>
                                  </>
                                )}
                              </div>
                            </div>
                          );
                        })
                      )}
                    </CardContent>
                  </Card>
                </>
              )}
            </motion.div>
          )}

          {/* CURRENCY */}
          {activeSection === "currency" && (
            <motion.div
              key="currency"
              initial={{ opacity: 0, x: 12 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0 }}
              className="space-y-4"
            >
              <Card>
                <CardHeader>
                  <CardTitle>Financial Settings</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <Field label="Currency">
                      <Select
                        value={String(formData.currency || "USD")}
                        onValueChange={(v) =>
                          setFormData({ ...formData, currency: v })
                        }
                        disabled={!isAdmin}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="USD">USD ($)</SelectItem>
                          <SelectItem value="ZWG">ZWG (ZiG)</SelectItem>
                          <SelectItem value="ZAR">ZAR (R)</SelectItem>
                        </SelectContent>
                      </Select>
                    </Field>

                    <Field label="Tax Rate (%)">
                      <Input
                        type="number"
                        value={String(formData.tax_rate ?? 0)}
                        onChange={(e) =>
                          setFormData({
                            ...formData,
                            tax_rate: normalizeTaxRate(e.target.value),
                          })
                        }
                        disabled={!isAdmin}
                        min={0}
                        max={100}
                      />
                      <p className="text-[11px] text-muted-foreground mt-1">
                        Set 0 to disable tax.
                      </p>
                    </Field>
                  </div>

                  <div className="flex items-center justify-between p-4 rounded-lg bg-muted/50">
                    <div>
                      <p className="font-medium">Prices Include Tax</p>
                      <p className="text-xs text-muted-foreground">
                        If checked, tax is calculated from the price.
                      </p>
                    </div>
                    <Switch
                      checked={!!formData.tax_included}
                      onCheckedChange={(c) =>
                        setFormData({ ...formData, tax_included: c })
                      }
                      disabled={!isAdmin}
                    />
                  </div>

                  {isAdmin && (
                    <div className="flex justify-end">
                      <Button
                        size="lg"
                        className="bg-primary hover:bg-blue-600 gap-2"
                        onClick={() => saveSettingsMutation.mutate(formData)}
                        disabled={saveSettingsMutation.isPending}
                      >
                        {saveSettingsMutation.isPending ? (
                          <Loader2 className="animate-spin" />
                        ) : (
                          <Save className="w-4 h-4" />
                        )}
                        Save Currency Settings
                      </Button>
                    </div>
                  )}
                </CardContent>
              </Card>
            </motion.div>
          )}

          {/* APPEARANCE */}
          {activeSection === "appearance" && (
            <motion.div
              key="appearance"
              initial={{ opacity: 0, x: 12 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0 }}
              className="space-y-4"
            >
              <Card>
                <CardHeader>
                  <CardTitle>Theme Preferences</CardTitle>
                </CardHeader>
                <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <button
                    onClick={() => isDark && toggleTheme()}
                    className={cn(
                      "p-4 rounded-xl border-2 text-left transition-all",
                      !isDark
                        ? "border-primary bg-primary/5"
                        : "border-border"
                    )}
                    type="button"
                  >
                    <div className="flex justify-between mb-2">
                      <Sun className="w-6 h-6" />
                      {!isDark && <Check className="w-4 h-4 text-primary" />}
                    </div>
                    <p className="font-bold">Light Mode</p>
                    <p className="text-xs text-muted-foreground mt-1">
                      Best visibility in bright rooms.
                    </p>
                  </button>

                  <button
                    onClick={() => !isDark && toggleTheme()}
                    className={cn(
                      "p-4 rounded-xl border-2 text-left transition-all",
                      isDark
                        ? "border-primary bg-primary/5"
                        : "border-border"
                    )}
                    type="button"
                  >
                    <div className="flex justify-between mb-2">
                      <Moon className="w-6 h-6" />
                      {isDark && <Check className="w-4 h-4 text-primary" />}
                    </div>
                    <p className="font-bold">Dark Mode</p>
                    <p className="text-xs text-muted-foreground mt-1">
                      Better for night shifts.
                    </p>
                  </button>
                </CardContent>
              </Card>
            </motion.div>
          )}

          {/* BACKUP */}
          {activeSection === "backup" && (
            <motion.div
              key="backup"
              initial={{ opacity: 0, x: 12 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0 }}
              className="space-y-4"
            >
              <Card>
                <CardHeader>
                  <CardTitle>Data Export</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="p-8 border-2 border-dashed border-border rounded-xl text-center">
                    <Database className="w-12 h-12 mx-auto text-muted-foreground mb-4" />
                    <h3 className="font-bold text-lg">Backup JSON</h3>
                    <p className="text-sm text-muted-foreground mb-6">
                      Export products, sales, settings and staff permissions.
                    </p>
	                    <Button
	                      variant="outline"
	                      onClick={handleExportData}
	                      className="gap-2"
	                      disabled={!isAdmin || !isOnline}
	                    >
	                      <Download className="w-4 h-4" /> Export Backup
	                    </Button>
	                    {!isAdmin && (
	                      <div className="text-xs text-muted-foreground mt-2">
	                        Admins only.
	                      </div>
	                    )}
	                    {isAdmin && !isOnline && (
	                      <div className="text-xs text-muted-foreground mt-2">
	                        Offline: connect to export a cloud backup.
	                      </div>
	                    )}
	                  </div>
	                </CardContent>
	              </Card>
	            </motion.div>
	          )}

	        </AnimatePresence>
	      </div>

      {/* USER DIALOG */}
      <Dialog
        open={showUserDialog}
        onOpenChange={(open) => {
          setShowUserDialog(open);
          if (!open) {
            setEditingUser(null);
            setUserForm({
              name: "",
              username: "",
              password: "",
              role: "cashier",
              permissions: { ...DEFAULT_PERMS },
              active: true,
            });
          }
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {editingUser ? "Edit Staff User" : "Create Staff User"}
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <Field label="Full Name">
              <Input
                value={userForm.name || ""}
                onChange={(e) =>
                  setUserForm({ ...userForm, name: e.target.value })
                }
                placeholder="John Doe"
                className={cn(
                  String(userForm.name || "").trim().length === 0
                    ? "border-red-500 focus-visible:ring-red-500"
                    : ""
                )}
              />
            </Field>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Field label="Username">
                <Input
                  value={userForm.username || ""}
                  onChange={(e) =>
                    setUserForm({ ...userForm, username: e.target.value })
                  }
                  placeholder="johnd"
                />
                <p className="text-[11px] text-muted-foreground mt-1">
                  Saved as:{" "}
                  <span className="font-mono">
                    @{sanitizeUsername(userForm.username || "")}
                  </span>
                </p>
              </Field>

              <Field label={editingUser ? "New Password (optional)" : "Password"}>
                <div className="relative">
                  <Input
                    type={editingUser ? "password" : showPassword ? "text" : "password"}
                    value={userForm.password || ""}
                    onChange={(e) =>
                      setUserForm({ ...userForm, password: e.target.value })
                    }
                    placeholder={
                      editingUser ? "Leave blank to keep current" : "******"
                    }
                  />
                  {!editingUser && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="absolute right-1 top-1/2 -translate-y-1/2 h-7 w-7"
                      onClick={() => setShowPassword((v) => !v)}
                    >
                      {showPassword ? (
                        <EyeOff className="w-3 h-3" />
                      ) : (
                        <Eye className="w-3 h-3" />
                      )}
                    </Button>
                  )}
                </div>
                {!editingUser && (
                  <p className="text-[11px] text-muted-foreground mt-1">
                    Minimum 6 characters.
                  </p>
                )}
              </Field>
            </div>

            <Field label="Role">
              <Select
                value={userForm.role || "cashier"}
                onValueChange={(v) =>
                  setUserForm({ ...userForm, role: v as any })
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="admin">Admin</SelectItem>
                  <SelectItem value="cashier">Staff</SelectItem>
                </SelectContent>
              </Select>
            </Field>

            <div className="flex items-center justify-between p-3 rounded-lg bg-muted/40 border border-border">
              <div className="space-y-0.5">
                <div className="font-medium text-sm">Account Active</div>
                <div className="text-xs text-muted-foreground">
                  Disable to block login without deleting.
                </div>
              </div>
              <Switch
                checked={userForm.active !== false}
                onCheckedChange={(c) =>
                  setUserForm({ ...userForm, active: c })
                }
              />
            </div>

            {userForm.role === "cashier" && (
              <div className="space-y-3 pt-2">
                <Label>Permissions</Label>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {[
                    { key: "allowInventory", label: "Inventory" },
                    { key: "allowDiscount", label: "Discounts" },
                    { key: "allowReports", label: "Reports" },
                    { key: "allowRefunds", label: "Refunds" },
                    { key: "allowVoid", label: "Void Sales" },
                    { key: "allowPriceEdit", label: "Edit Prices" },
                    { key: "allowSettings", label: "Settings" },
                    { key: "allowEditReceipt", label: "Edit Receipts" },
                  ].map(({ key, label }) => (
                    <div
                      key={key}
                      className="flex items-center justify-between p-2 rounded bg-muted/50 border border-border"
                    >
                      <span className="text-sm">{label}</span>
                      <Switch
                        checked={!!userForm.permissions?.[key]}
                        onCheckedChange={() =>
                          handlePermissionToggle(key as keyof UserPermissions)
                        }
                      />
                    </div>
                  ))}
                </div>

                <div className="text-[11px] text-muted-foreground">
                  Permissions are enforced across POS actions.
                </div>
              </div>
            )}
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowUserDialog(false)}
            >
              Cancel
            </Button>
            <Button
              onClick={() => saveUserMutation.mutate(userForm)}
              disabled={saveUserMutation.isPending || !isAdmin}
              className="gap-2"
            >
              {saveUserMutation.isPending ? (
                <Loader2 className="animate-spin" />
              ) : (
                <Save className="w-4 h-4" />
              )}
              {editingUser ? "Save Changes" : "Create User"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

/* ============================
   SMALL UI HELPERS
============================ */

const Field = ({
  label,
  children,
  full,
}: {
  label: string;
  children: React.ReactNode;
  full?: boolean;
}) => (
  <div className={cn("space-y-2", full && "md:col-span-2")}>
    <Label>{label}</Label>
    {children}
  </div>
);

const ToggleRow = ({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) => (
  <div className="flex items-center justify-between">
    <span className="text-sm">{label}</span>
    <Switch checked={value} onCheckedChange={onChange} />
  </div>
);
