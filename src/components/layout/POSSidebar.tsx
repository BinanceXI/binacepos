// File: src/components/POSSidebar.tsx
import { useMemo, useState } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { motion } from "framer-motion";
import {
  LayoutDashboard,
  ShoppingCart,
  Package,
  BarChart3,
  Settings,
  Printer,
  Wallet,
  ChevronLeft,
  ChevronRight,
  PieChart,
  Shield,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { usePOS } from "@/contexts/POSContext";
import { BRAND } from "@/lib/brand";

const navItems = [
  { path: "/platform", label: "Admin", icon: Shield },
  { path: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { path: "/pos", label: "Point of Sale", icon: ShoppingCart },
  { path: "/inventory", label: "Inventory", icon: Package },
  { path: "/profit", label: "Profit Analysis", icon: PieChart },
  { path: "/receipts", label: "Receipts", icon: Printer },
  { path: "/expenses", label: "Expenses", icon: Wallet },
  { path: "/reports", label: "Reports", icon: BarChart3 },
  { path: "/settings", label: "Settings", icon: Settings },
];

export const POSSidebar = () => {
  const [collapsed, setCollapsed] = useState(false);
  const location = useLocation();
  const { currentUser } = usePOS();

  const role = (currentUser as any)?.role;
  const isPlatform = role === "platform_admin";
  const isAdmin = role === "admin";
  const isCashier = role === "cashier";

  // ✅ Cashier sees ONLY POS
  const visibleItems = useMemo(() => {
    if (!currentUser) return [];
    if (isPlatform) return navItems.filter((i) => i.path === "/platform");
    if (isCashier) return navItems.filter((i) => i.path === "/pos");
    if (isAdmin) return navItems.filter((i) => i.path !== "/platform");
    return navItems.filter((i) => i.path === "/pos");
  }, [currentUser, isAdmin, isCashier, isPlatform]);

  const displayName =
    (currentUser as any)?.full_name ||
    (currentUser as any)?.name ||
    (currentUser as any)?.username ||
    "User";

  return (
    <>
      {/* ✅ FIXED (doesn't scroll) + SMALLER WIDTH */}
      <motion.aside
        initial={false}
        animate={{ width: collapsed ? 74 : 236 }}
        transition={{ duration: 0.24, ease: [0.2, 0.7, 0.2, 1] }}
        className={cn(
          "hidden md:flex flex-col z-30",
          "fixed left-0 top-0 h-screen",
          "bg-[hsl(var(--sidebar-background))/0.94] border-r border-white/10 backdrop-blur-xl"
        )}
      >
        {/* ===== BRAND HEADER (NO LOGO) ===== */}
        <div className={cn("px-4 pt-4 pb-3 border-b border-white/10", collapsed && "px-3")}>
          <div className={cn("flex items-start", collapsed ? "justify-center" : "justify-between")}>
            {!collapsed ? (
              <div className="min-w-0">
                <div className="text-white font-semibold text-[15px] tracking-tight leading-tight">
                  {BRAND.name}
                </div>
                <div className="text-white/55 text-[12px] mt-0.5 truncate">
                  {displayName} • {role || "—"}
                </div>
              </div>
            ) : (
              <div className="text-white font-bold text-[13px] tracking-tight leading-none">
                {String(BRAND.shortName || BRAND.name || "BX").trim().slice(0, 2).toUpperCase()}
              </div>
            )}
          </div>

          {!collapsed && (
            <div className="mt-3">
              <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full border border-white/10 bg-white/[0.04]">
                <span
                  className={cn(
                    "h-2 w-2 rounded-full",
                    navigator.onLine ? "bg-emerald-400" : "bg-amber-300"
                  )}
                />
                <span className="text-[12px] text-white/75">
                  {navigator.onLine ? "Online" : "Offline"}
                </span>
              </div>
            </div>
          )}
        </div>

        {/* ===== NAV ===== */}
        <nav className={cn("flex-1 overflow-y-auto", collapsed ? "px-2 py-3" : "px-3 py-3")}>
          <div className="space-y-2">
            {visibleItems.map((item) => {
              const isActive = location.pathname === item.path;

              return (
                <NavLink
                  key={item.path}
                  to={item.path}
                  className={cn(
                    "group relative flex items-center rounded-xl transition-all duration-300",
                    collapsed ? "justify-center px-2 py-3" : "px-3 py-3",
                    isActive
                      ? "bg-white/11 border border-white/18 shadow-[0_14px_22px_-18px_rgba(0,0,0,0.7)]"
                      : "border border-transparent hover:bg-white/[0.05] hover:border-white/10"
                  )}
                >
                  {isActive && (
                    <motion.div
                      layoutId="activeBar"
                      className="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-8 bg-[hsl(var(--sidebar-primary))] rounded-r-full"
                    />
                  )}

                  <item.icon
                    className={cn(
                      "shrink-0 w-5 h-5",
                      isActive ? "text-[hsl(var(--sidebar-primary))]" : "text-white/72 group-hover:text-white"
                    )}
                  />

                  {!collapsed && (
                    <div className="ml-3 flex-1 min-w-0">
                      <div className={cn("text-[14px] font-medium truncate", isActive ? "text-white" : "text-white/82")}>
                        {item.label}
                      </div>
                      <div className="text-[11px] text-white/48 truncate">
                        {item.path === "/pos" ? "Sell & checkout" : ""}
                        {item.path === "/inventory" ? "Stock & products" : ""}
                        {item.path === "/reports" ? "Analytics & exports" : ""}
                        {item.path === "/settings" ? "System controls" : ""}
                        {item.path === "/receipts" ? "Printed history" : ""}
                        {item.path === "/profit" ? "Margins & trends" : ""}
                        {item.path === "/dashboard" ? "Overview" : ""}
                      </div>
                    </div>
                  )}

                  {collapsed && (
                    <div className="absolute left-full ml-3 px-3 py-1.5 rounded-lg text-xs font-medium opacity-0 group-hover:opacity-100 pointer-events-none whitespace-nowrap z-50 border border-white/10 bg-black/75 text-white shadow-lg">
                      {item.label}
                    </div>
                  )}
                </NavLink>
              );
            })}
          </div>

          {!collapsed && isCashier && (
            <div className="mt-4 px-3 py-3 rounded-xl border border-white/12 bg-white/[0.04] fade-rise">
              <div className="text-[12px] text-white/75 font-medium">Cashier Mode</div>
              <div className="text-[11px] text-white/50 mt-0.5">POS only access</div>
            </div>
          )}
        </nav>

        {/* ===== COLLAPSE ===== */}
        <div className={cn("border-t border-white/10", collapsed ? "p-2" : "p-3")}>
          <button
            onClick={() => setCollapsed((v) => !v)}
            className={cn(
              "w-full rounded-xl transition-colors duration-300 flex items-center justify-center gap-2",
              "text-white/70 hover:text-white bg-white/[0.03] hover:bg-white/[0.07]",
              "border border-white/12",
              "py-2"
            )}
          >
            {collapsed ? (
              <ChevronRight className="w-5 h-5" />
            ) : (
              <>
                <ChevronLeft className="w-5 h-5" />
                <span className="text-sm font-medium">Collapse</span>
              </>
            )}
          </button>
        </div>
      </motion.aside>

      {/* ✅ Spacer so page content doesn't go under fixed sidebar */}
      <div className={cn("hidden md:block", collapsed ? "w-[74px]" : "w-[236px]")} />
    </>
  );
};
