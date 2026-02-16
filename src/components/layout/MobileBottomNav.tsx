import { NavLink, useLocation } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  LayoutDashboard,
  ShoppingCart,
  Package,
  BarChart3,
  Settings,
  Wallet,
  Shield,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { usePOS } from '@/contexts/POSContext';

const navItems = [
  { path: '/platform', label: 'Admin', icon: Shield },
  { path: '/dashboard', label: 'Home', icon: LayoutDashboard },
  { path: '/pos', label: 'POS', icon: ShoppingCart },
  { path: '/inventory', label: 'Stock', icon: Package },
  { path: '/expenses', label: 'Expenses', icon: Wallet },
  { path: '/reports', label: 'Reports', icon: BarChart3 },
  { path: '/settings', label: 'Settings', icon: Settings },
];

export const MobileBottomNav = () => {
  const location = useLocation();
  const { currentUser, cart } = usePOS();

  // Filter nav items based on user permissions
  const filteredNavItems = navItems.filter(item => {
    if (item.path === '/platform') return currentUser?.role === 'platform_admin';
    if (!currentUser?.permissions) return true;
    if (item.path === '/expenses' && currentUser.role !== 'admin') return false;
    if (item.path === '/reports' && !currentUser.permissions.allowReports) return false;
    if (item.path === '/inventory' && !currentUser.permissions.allowInventory) return false;
    if (item.path === '/settings' && !currentUser.permissions.allowSettings) return false;
    return true;
  });

  return (
    <nav className="md:hidden fixed bottom-0 left-0 right-0 bg-background/88 backdrop-blur-xl border-t border-border/80 z-50 safe-area-bottom">
      <div className="flex items-center justify-around h-16 px-1">
        {filteredNavItems.map((item) => {
          const isActive = location.pathname === item.path;
          return (
            <NavLink
              key={item.path}
              to={item.path}
              className={cn(
                'flex flex-col items-center justify-center gap-1 flex-1 py-2 transition-all duration-300 relative rounded-xl',
                isActive
                  ? 'text-primary bg-primary/10'
                  : 'text-muted-foreground'
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
                {item.path === '/pos' && cart.length > 0 && (
                  <span className="absolute -top-1 -right-1 w-4 h-4 bg-destructive text-destructive-foreground text-[10px] font-bold rounded-full flex items-center justify-center">
                    {cart.length}
                  </span>
                )}
              </div>
              <span className="text-[10px] font-medium">{item.label}</span>
            </NavLink>
          );
        })}
      </div>
    </nav>
  );
};
