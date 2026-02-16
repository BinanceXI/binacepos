import { useEffect } from 'react';
import { motion } from 'framer-motion';
import {
  DollarSign,
  ShoppingCart,
  TrendingUp,
  AlertTriangle,
  ArrowUpRight,
  ArrowDownRight,
  CreditCard,
  Smartphone,
  Banknote,
  Package,
  Clock,
  Loader2,
  BarChart3
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useNavigate } from 'react-router-dom';
// ✅ REAL BACKEND CONNECTION
import { supabase } from '@/lib/supabase';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { startOfDay, endOfDay, format } from 'date-fns';

// --- COMPONENTS ---

const StatCard = ({
  title,
  value,
  subtitle,
  icon: Icon,
  iconColor,
  trend
}: {
  title: string;
  value: string;
  subtitle?: string;
  icon: React.ElementType;
  iconColor: string;
  trend?: 'up' | 'down' | 'neutral';
}) => (
  <Card className="relative overflow-hidden">
    <CardContent className="p-6">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-sm font-medium text-muted-foreground">{title}</p>
          <h3 className="text-2xl font-bold mt-1">{value}</h3>
          {subtitle && (
            <div className="flex items-center gap-1 mt-2 text-xs text-muted-foreground">
              {trend === 'up' && <ArrowUpRight className="w-3 h-3 text-green-500" />}
              {trend === 'down' && <ArrowDownRight className="w-3 h-3 text-red-500" />}
              <span>{subtitle}</span>
            </div>
          )}
        </div>
        <div className={`w-12 h-12 rounded-xl flex items-center justify-center ${iconColor}`}>
          <Icon className="w-6 h-6" />
        </div>
      </div>
    </CardContent>
  </Card>
);

export const DashboardPage = () => {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const today = new Date();
  const dayKey = format(today, 'yyyy-MM-dd');

  useEffect(() => {
    const channel = supabase
      .channel('dashboard-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'orders' }, () => {
        void queryClient.invalidateQueries({ queryKey: ['dashboardStats'] });
        void queryClient.invalidateQueries({ queryKey: ['recentTx'] });
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'products' }, () => {
        void queryClient.invalidateQueries({ queryKey: ['lowStock'] });
      })
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [queryClient]);

  // --- 1. FETCH TODAY'S ORDERS (REAL DATA) ---
  const { data: todayStats, isLoading: statsLoading } = useQuery({
    queryKey: ['dashboardStats', dayKey],
    queryFn: async () => {
      const start = startOfDay(today).toISOString();
      const end = endOfDay(today).toISOString();
      
      const { data, error } = await supabase
        .from('orders')
        .select('*')
        .gte('created_at', start)
        .lte('created_at', end);
      
      if (error) throw error;
      return data || [];
    },
    // Cache for 1 minute so dashboard feels live
    refetchInterval: 60000 
  });

  // --- 2. FETCH LOW STOCK ITEMS ---
  const { data: lowStockItems } = useQuery({
    queryKey: ['lowStock'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('products')
        .select('*')
        .eq('type', 'good') // Only check physical goods
        .lt('stock_quantity', 6) // Threshold < 6
        .limit(5);

      if (error) throw error;
      return data || [];
    }
  });

  // --- 3. FETCH RECENT TRANSACTIONS ---
  const { data: recentTx } = useQuery({
    queryKey: ['recentTx'],
    queryFn: async () => {
      const { data: orders, error } = await supabase
        .from('orders')
        .select(`
          id, 
          total_amount, 
          payment_method, 
          created_at, 
          customer_name,
          cashier_id
        `)
        .order('created_at', { ascending: false })
        .limit(5);

      if (error) throw error;
      const cashierIds = Array.from(
        new Set((orders || []).map((o: any) => o?.cashier_id).filter(Boolean))
      ) as string[];

      let cashierMap = new Map<string, string>();
      if (cashierIds.length > 0) {
        const { data: profs, error: profErr } = await supabase
          .from('profiles')
          .select('id,full_name')
          .in('id', cashierIds);

        if (!profErr) {
          cashierMap = new Map(
            (profs || []).map((p: any) => [String(p.id), String(p.full_name || 'Cashier')])
          );
        }
      }

      return (orders || []).map((o: any) => ({
        ...o,
        profiles: { full_name: cashierMap.get(String(o.cashier_id || '')) || 'Cashier' },
      }));
    }
  });

  // --- CALCULATIONS ---
  const totalRevenue = todayStats?.reduce((sum, order) => sum + Number(order.total_amount), 0) || 0;
  const transactionCount = todayStats?.length || 0;
  const avgTicket = transactionCount > 0 ? totalRevenue / transactionCount : 0;

  // Payment Method Splits
  const payments = {
    cash: todayStats?.filter(o => o.payment_method === 'cash').reduce((sum, o) => sum + Number(o.total_amount), 0) || 0,
    card: todayStats?.filter(o => o.payment_method === 'card' || o.payment_method === 'swipe').reduce((sum, o) => sum + Number(o.total_amount), 0) || 0,
    ecocash: todayStats?.filter(o => o.payment_method === 'ecocash').reduce((sum, o) => sum + Number(o.total_amount), 0) || 0,
  };

  if (statsLoading) {
    return <div className="flex h-screen items-center justify-center"><Loader2 className="h-8 w-8 animate-spin text-primary" /></div>;
  }

  return (
    <div className="p-6 space-y-6 pb-24 lg:pb-6">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Dashboard</h1>
          <p className="text-muted-foreground">Overview for {format(today, 'EEEE, d MMMM yyyy')}</p>
        </div>
        <div className="flex gap-2">
           <Button 
            variant="outline" 
            onClick={() => navigate('/reports')}
            className="gap-2"
          >
            <BarChart3 className="w-4 h-4" />
            View Reports
          </Button>
          <Button 
            onClick={() => navigate('/pos')}
            className="bg-primary hover:bg-primary/90 text-primary-foreground gap-2 shadow-[0_18px_30px_-22px_hsl(var(--primary)/0.9)]"
          >
            <ShoppingCart className="w-4 h-4" />
            New Sale
          </Button>
        </div>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0 }}>
          <StatCard
            title="Today's Revenue"
            value={`$${totalRevenue.toLocaleString()}`}
            subtitle="Gross sales calculated from today's orders"
            trend="up"
            icon={DollarSign}
            iconColor="bg-primary/12 text-primary"
          />
        </motion.div>
        
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }}>
          <StatCard
            title="Transactions"
            value={transactionCount.toString()}
            subtitle="Total receipts generated today"
            trend="neutral"
            icon={ShoppingCart}
            iconColor="bg-blue-500/10 text-blue-500"
          />
        </motion.div>
        
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2 }}>
          <StatCard
            title="Average Ticket"
            value={`$${avgTicket.toFixed(2)}`}
            subtitle="Avg. value per customer"
            trend="neutral"
            icon={TrendingUp}
            iconColor="bg-indigo-500/10 text-indigo-500"
          />
        </motion.div>
        
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.3 }}>
          <StatCard
            title="Low Stock Items"
            value={(lowStockItems?.length || 0).toString()}
            subtitle="Products needing restock"
            trend={(lowStockItems?.length || 0) > 0 ? 'down' : 'neutral'}
            icon={AlertTriangle}
            iconColor="bg-amber-500/10 text-amber-500"
          />
        </motion.div>
      </div>

      {/* Middle Section */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        
        {/* Payment Breakdown */}
        <Card className="lg:col-span-1 border-border/50 shadow-sm">
          <CardHeader className="pb-3">
            <CardTitle className="text-base font-semibold">Payment Methods</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-3">
              <PaymentRow 
                label="Cash (USD/ZiG)" 
                amount={payments.cash} 
                total={totalRevenue} 
                icon={Banknote} 
                color="text-primary" 
                bg="bg-primary/10" 
              />
              <PaymentRow 
                label="Card / Swipe" 
                amount={payments.card} 
                total={totalRevenue} 
                icon={CreditCard} 
                color="text-blue-500" 
                bg="bg-blue-500/10" 
              />
              <PaymentRow 
                label="EcoCash / Mobile" 
                amount={payments.ecocash} 
                total={totalRevenue} 
                icon={Smartphone} 
                color="text-indigo-500" 
                bg="bg-indigo-500/10" 
              />
            </div>
          </CardContent>
        </Card>

        {/* Recent Transactions */}
        <Card className="lg:col-span-2 border-border/50 shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between pb-3">
            <CardTitle className="text-base font-semibold">Recent Transactions</CardTitle>
            <Button variant="ghost" size="sm" onClick={() => navigate('/reports')}>View All</Button>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {recentTx?.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">No sales yet today</div>
              ) : (
                recentTx?.map((tx: any, i: number) => (
                  <motion.div
                    key={tx.id}
                    initial={{ opacity: 0, x: -10 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: i * 0.05 }}
                    className="flex items-center justify-between p-3 rounded-lg hover:bg-accent/50 transition-colors border border-transparent hover:border-border/50"
                  >
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-full bg-secondary flex items-center justify-center">
                        <Clock className="w-4 h-4 text-muted-foreground" />
                      </div>
                      <div>
                        <p className="font-medium text-sm">{tx.customer_name || 'Walk-in Customer'}</p>
                        <p className="text-xs text-muted-foreground">
                          {tx.profiles?.full_name || 'Cashier'} • {format(new Date(tx.created_at), 'HH:mm')}
                        </p>
                      </div>
                    </div>
                    <div className="text-right">
                      <p className="font-bold text-sm">${Number(tx.total_amount).toFixed(2)}</p>
                      <p className="text-xs text-muted-foreground capitalize">{tx.payment_method}</p>
                    </div>
                  </motion.div>
                ))
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Low Stock Alerts */}
      <Card className="border-border/50 shadow-sm">
        <CardHeader className="flex flex-row items-center justify-between pb-3">
          <CardTitle className="text-base font-semibold flex items-center gap-2">
            <AlertTriangle className="w-5 h-5 text-amber-500" />
            Low Stock Alerts
          </CardTitle>
          <Button variant="ghost" size="sm" onClick={() => navigate('/inventory')}>
            Restock
          </Button>
        </CardHeader>
        <CardContent>
          {lowStockItems?.length === 0 ? (
            <div className="text-sm text-muted-foreground py-4">All stock levels are healthy!</div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
              {lowStockItems?.map((product: any, i: number) => (
                <motion.div
                  key={product.id}
                  initial={{ opacity: 0, scale: 0.95 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={{ delay: i * 0.05 }}
                  className="flex items-center gap-3 p-3 rounded-lg border border-amber-500/20 bg-amber-500/5"
                >
                  <div className="w-10 h-10 rounded-lg bg-amber-500/10 flex items-center justify-center">
                    <Package className="w-5 h-5 text-amber-500" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-sm truncate">{product.name}</p>
                    <p className="text-xs text-amber-500 font-medium">
                      {product.stock_quantity} remaining
                    </p>
                  </div>
                </motion.div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
};

// Helper Component for Payment Rows
const PaymentRow = ({ label, amount, total, icon: Icon, color, bg }: any) => (
  <div className="flex items-center justify-between">
    <div className="flex items-center gap-3">
      <div className={`w-10 h-10 rounded-lg ${bg} flex items-center justify-center`}>
        <Icon className={`w-5 h-5 ${color}`} />
      </div>
      <div>
        <p className="font-medium text-sm">{label}</p>
        <p className="text-xs text-muted-foreground">
          {total > 0 ? ((amount / total) * 100).toFixed(0) : 0}% of sales
        </p>
      </div>
    </div>
    <p className="font-semibold">${amount.toLocaleString()}</p>
  </div>
);
