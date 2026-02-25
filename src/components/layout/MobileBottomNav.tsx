import { useState } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { motion } from "framer-motion";
import {
  LayoutDashboard,
  ShoppingCart,
  Package,
  BarChart3,
  Settings,
  Wallet,
  Shield,
  Printer,
  PieChart,
  MoreHorizontal,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { usePOS } from "@/contexts/POSContext";
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from "@/components/ui/drawer";

type NavItem = { path: string; label: string; icon: any; badge?: boolean };

const PLATFORM_PRIMARY_ITEMS: NavItem[] = [
  { path: "/platform/overview", label: "Home", icon: Shield },
  { path: "/platform/businesses", label: "Biz", icon: LayoutDashboard },
  { path: "/platform/activation-requests", label: "Requests", icon: Wallet },
  { path: "/platform/support", label: "Support", icon: MoreHorizontal },
];

const PLATFORM_MORE_ITEMS: NavItem[] = [
  { path: "/platform/users", label: "Users", icon: Settings },
  { path: "/platform/devices", label: "Devices", icon: Package },
  { path: "/platform/plans", label: "Plans", icon: Wallet },
  { path: "/platform/analytics", label: "Analytics", icon: BarChart3 },
  { path: "/platform/audit-logs", label: "Audit", icon: Shield },
  { path: "/platform/settings", label: "Settings", icon: Settings },
];
const CASHIER_ITEMS: NavItem[] = [{ path: "/pos", label: "POS", icon: ShoppingCart, badge: true }];

// Mobile bottom nav must stay compact; extra admin pages live under "More".
const ADMIN_PRIMARY_ITEMS: NavItem[] = [
  { path: "/dashboard", label: "Home", icon: LayoutDashboard },
  { path: "/pos", label: "POS", icon: ShoppingCart, badge: true },
  { path: "/inventory", label: "Stock", icon: Package },
  { path: "/receipts", label: "Receipts", icon: Printer },
];

const ADMIN_MORE_ITEMS: NavItem[] = [
  { path: "/profit", label: "Profit", icon: PieChart },
  { path: "/expenses", label: "Expenses", icon: Wallet },
  { path: "/reports", label: "Reports", icon: BarChart3 },
  { path: "/settings", label: "Settings", icon: Settings },
];

export const MobileBottomNav = () => {
  const location = useLocation();
  const { currentUser, cart } = usePOS();

  const role = (currentUser as any)?.role;
  const isPlatform = role === "platform_admin";
  const isCashier = role === "cashier";
  const isAdmin = role === "admin";

  const [moreOpen, setMoreOpen] = useState(false);

  if (!currentUser) return null;

  const primaryItems: NavItem[] = isPlatform
    ? PLATFORM_PRIMARY_ITEMS
    : isCashier
    ? CASHIER_ITEMS
    : isAdmin
    ? ADMIN_PRIMARY_ITEMS
    : CASHIER_ITEMS;

  const moreItems: NavItem[] = isPlatform ? PLATFORM_MORE_ITEMS : isAdmin ? ADMIN_MORE_ITEMS : [];
  const isMoreActive = moreItems.some((i) => location.pathname === i.path);

  return (
    <>
      <nav className="md:hidden fixed bottom-0 left-0 right-0 bg-background/88 backdrop-blur-xl border-t border-border/80 z-50 pb-[env(safe-area-inset-bottom)]">
        <div className="flex items-center justify-around h-16 px-1">
          {primaryItems.map((item) => {
            const isActive = location.pathname === item.path;
            return (
              <NavLink
                key={item.path}
                to={item.path}
                className={cn(
                  "flex flex-col items-center justify-center gap-1 flex-1 py-2 transition-all duration-300 relative rounded-xl",
                  isActive ? "text-primary bg-primary/10" : "text-muted-foreground"
                )}
              >
                {isActive && (
                  <motion.div
                    layoutId="mobileActiveIndicator"
                    className="absolute top-0 left-1/2 -translate-x-1/2 w-8 h-[2px] bg-primary rounded-b-full"
                  />
                )}
                <div className="relative">
                  <item.icon className="w-6 h-6" />
                  {item.badge && cart.length > 0 && (
                    <span className="absolute -top-1 -right-1 min-w-4 h-4 px-1 bg-destructive text-destructive-foreground text-[10px] font-bold rounded-full flex items-center justify-center">
                      {cart.length}
                    </span>
                  )}
                </div>
                <span className="text-[10px] font-medium">{item.label}</span>
              </NavLink>
            );
          })}

          {moreItems.length > 0 && (
            <button
              type="button"
              onClick={() => setMoreOpen(true)}
              className={cn(
                "flex flex-col items-center justify-center gap-1 flex-1 py-2 transition-all duration-300 relative rounded-xl",
                isMoreActive ? "text-primary bg-primary/10" : "text-muted-foreground"
              )}
            >
              {isMoreActive && (
                <motion.div
                  layoutId="mobileActiveIndicator"
                  className="absolute top-0 left-1/2 -translate-x-1/2 w-8 h-[2px] bg-primary rounded-b-full"
                />
              )}
              <MoreHorizontal className="w-6 h-6" />
              <span className="text-[10px] font-medium">More</span>
            </button>
          )}
        </div>
      </nav>

      <Drawer open={moreOpen} onOpenChange={setMoreOpen}>
        <DrawerContent className="md:hidden pb-[calc(1rem+env(safe-area-inset-bottom))]">
          <DrawerHeader className="text-left">
            <DrawerTitle>More</DrawerTitle>
          </DrawerHeader>
          <div className="px-4 pb-4 grid gap-2">
            {moreItems.map((item) => (
              <NavLink
                key={item.path}
                to={item.path}
                onClick={() => setMoreOpen(false)}
                className={cn(
                  "flex items-center gap-3 rounded-xl border border-border/80 bg-card/70 hover:bg-card px-4 py-3"
                )}
              >
                <item.icon className="w-5 h-5 text-primary" />
                <div className="font-medium">{item.label}</div>
              </NavLink>
            ))}
          </div>
        </DrawerContent>
      </Drawer>
    </>
  );
};
