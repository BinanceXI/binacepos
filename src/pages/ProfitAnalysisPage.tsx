import { useState, useMemo, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { 
  startOfDay, endOfDay, subDays, startOfMonth, 
  format, parseISO, getHours 
} from 'date-fns';
import { 
  DollarSign, TrendingUp, TrendingDown, Calendar as CalendarIcon, 
  BarChart3, Loader2, PieChart, Download, AlertCircle, ChevronDown
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { motion, AnimatePresence } from 'framer-motion';
import { toast } from 'sonner';

export const ProfitAnalysisPage = () => {
  const [rangeType, setRangeType] = useState<'today' | 'week' | 'month' | 'custom'>('week');
  const [customDate, setCustomDate] = useState<string>(new Date().toISOString().split('T')[0]);

  // --- KEYBOARD SHORTCUTS ---
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't trigger if typing in an input
      if (document.activeElement?.tagName === 'INPUT') return;
      
      if (e.key === 'd' || e.key === 'D') setRangeType('today');
      if (e.key === 'w' || e.key === 'W') setRangeType('week');
      if (e.key === 'm' || e.key === 'M') setRangeType('month');
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // --- 1. FETCH DATA (Smart Query) ---
  const { data: salesData = [], isLoading } = useQuery({
    queryKey: ['profitAnalysis', rangeType, customDate],
    queryFn: async () => {
      const now = new Date();
      let start = startOfDay(now);
      let end = endOfDay(now);

      // Determine Time Range
      if (rangeType === 'today') {
        start = startOfDay(now);
        end = endOfDay(now);
      } else if (rangeType === 'week') {
        start = subDays(now, 7);
        end = endOfDay(now);
      } else if (rangeType === 'month') {
        start = startOfMonth(now);
        end = endOfDay(now);
      } else if (rangeType === 'custom') {
        const selected = new Date(customDate);
        start = startOfDay(selected);
        end = endOfDay(selected);
      }

      const { data, error } = await supabase
        .from('order_items')
        .select(`
          quantity,
          price_at_sale,
          cost_at_sale,
          created_at,
          products (
            name,
            cost_price,
            category
          )
        `)
        .gte('created_at', start.toISOString())
        .lte('created_at', end.toISOString())
        .order('created_at', { ascending: true });

      if (error) throw error;
      return data;
    },
    staleTime: 1000 * 60 * 5 // Cache for 5 mins
  });

  // --- 2. CALCULATE METRICS (Advanced) ---
  const stats = useMemo(() => {
    let totalRevenue = 0;
    let totalCost = 0;
    let itemCount = 0;
    const productPerformance: Record<string, any> = {};
    const chartMap: Record<string, { label: string, revenue: number, profit: number }> = {};

    salesData.forEach((item: any) => {
      const qty = item.quantity;
      const price = Number(item.price_at_sale);
      // Fallback to product cost if historical cost is missing
      const cost = item.cost_at_sale ? Number(item.cost_at_sale) : (item.products?.cost_price || 0);
      const productName = item.products?.name || 'Unknown Item';
      const dateObj = parseISO(item.created_at);

      const revenue = price * qty;
      const itemCost = cost * qty;
      const profit = revenue - itemCost;

      totalRevenue += revenue;
      totalCost += itemCost;
      itemCount += qty;

      // Product grouping
      if (!productPerformance[productName]) {
        productPerformance[productName] = { name: productName, revenue: 0, profit: 0, qty: 0 };
      }
      productPerformance[productName].revenue += revenue;
      productPerformance[productName].profit += profit;
      productPerformance[productName].qty += qty;

      // Chart grouping logic
      let key;
      // If viewing a single day (Today or Custom), group by HOUR
      if (rangeType === 'today' || rangeType === 'custom') {
        key = format(dateObj, 'HH:00'); 
      } else {
        // If viewing week/month, group by DAY
        key = format(dateObj, 'MMM dd');
      }

      if (!chartMap[key]) {
        chartMap[key] = { label: key, revenue: 0, profit: 0 };
      }
      chartMap[key].revenue += revenue;
      chartMap[key].profit += profit;
    });

    const totalProfit = totalRevenue - totalCost;
    const margin = totalRevenue > 0 ? (totalProfit / totalRevenue) * 100 : 0;

    // Fill in empty hours/days for better chart visuals if needed
    // (Skipped for brevity, can be added for "State of the Art" polish later)

    return {
      revenue: totalRevenue,
      cost: totalCost,
      profit: totalProfit,
      margin,
      itemsSold: itemCount,
      topProducts: Object.values(productPerformance).sort((a: any, b: any) => b.profit - a.profit).slice(0, 5),
      chartData: Object.values(chartMap)
    };
  }, [salesData, rangeType]);

  // --- EXPORT CSV ---
  const handleExport = () => {
    if (salesData.length === 0) return toast.error("No data to export");
    
    const csvContent = [
      ["Date", "Time", "Product", "Quantity", "Revenue", "Cost", "Profit"],
      ...salesData.map((item: any) => {
        const date = parseISO(item.created_at);
        const rev = item.price_at_sale * item.quantity;
        const cost = (item.cost_at_sale || item.products?.cost_price || 0) * item.quantity;
        return [
          format(date, 'yyyy-MM-dd'),
          format(date, 'HH:mm:ss'),
          item.products?.name || 'Unknown',
          item.quantity,
          rev.toFixed(2),
          cost.toFixed(2),
          (rev - cost).toFixed(2)
        ];
      })
    ].map(e => e.join(",")).join("\n");

    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.setAttribute("href", url);
    link.setAttribute("download", `profit_report_${rangeType}_${customDate}.csv`);
    document.body.appendChild(link);
    link.click();
    toast.success("Report Downloaded");
  };

  if (isLoading) return <div className="flex h-screen items-center justify-center"><Loader2 className="animate-spin h-8 w-8 text-primary"/></div>;

  return (
    <div className="p-4 md:p-6 space-y-6 pb-24 md:pb-6 bg-slate-50/50 dark:bg-slate-950/50 min-h-screen">
      {/* Header */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Profit & Loss</h1>
          <p className="text-muted-foreground flex items-center gap-2 text-sm">
            Financial breakdown
            <span className="hidden lg:inline-flex text-[10px] bg-muted px-1.5 py-0.5 rounded border border-border">
              Shortcuts: D, W, M
            </span>
          </p>
        </div>
        
        <div className="flex flex-wrap gap-2 items-center">
          <Button variant="outline" onClick={handleExport} className="gap-2 h-9 text-xs">
            <Download className="w-3.5 h-3.5" /> Export
          </Button>
          
          <div className="flex bg-card border border-border rounded-lg p-1 items-center gap-1 shadow-sm">
             <Select value={rangeType} onValueChange={(v: any) => setRangeType(v)}>
              <SelectTrigger className="w-[130px] h-7 text-xs border-none bg-transparent focus:ring-0">
                <CalendarIcon className="w-3.5 h-3.5 mr-2 text-muted-foreground" />
                <SelectValue placeholder="Range" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="today">Today (Hourly)</SelectItem>
                <SelectItem value="week">Last 7 Days</SelectItem>
                <SelectItem value="month">This Month</SelectItem>
                <SelectItem value="custom">Specific Day</SelectItem>
              </SelectContent>
            </Select>

            <AnimatePresence>
              {rangeType === 'custom' && (
                <motion.div 
                  initial={{ width: 0, opacity: 0 }} 
                  animate={{ width: 'auto', opacity: 1 }}
                  exit={{ width: 0, opacity: 0 }}
                  className="overflow-hidden"
                >
                  <Input 
                    type="date" 
                    value={customDate} 
                    onChange={(e) => setCustomDate(e.target.value)}
                    className="h-7 w-[130px] text-xs border-l border-border rounded-none pl-3 bg-transparent"
                  />
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard 
          title="Total Revenue" 
          value={`$${stats.revenue.toLocaleString(undefined, {minimumFractionDigits: 2})}`}
          icon={DollarSign}
          color="text-blue-500 bg-blue-500/10"
        />
        <StatCard 
          title="Cost of Goods" 
          value={`$${stats.cost.toLocaleString(undefined, {minimumFractionDigits: 2})}`}
          icon={TrendingDown}
          color="text-red-500 bg-red-500/10"
        />
        <StatCard 
          title="Net Profit" 
          value={`$${stats.profit.toLocaleString(undefined, {minimumFractionDigits: 2})}`}
          icon={TrendingUp}
          color="text-emerald-500 bg-emerald-500/10"
        />
        <StatCard 
          title="Profit Margin" 
          value={`${stats.margin.toFixed(1)}%`}
          icon={PieChart}
          color={stats.margin > 20 ? "text-violet-500 bg-violet-500/10" : "text-amber-500 bg-amber-500/10"}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        
        {/* Chart */}
        <Card className="lg:col-span-2 border-border/50 shadow-sm bg-card/50 backdrop-blur-sm">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <BarChart3 className="w-5 h-5 text-muted-foreground" /> 
              {rangeType === 'today' || rangeType === 'custom' ? 'Hourly Performance' : 'Daily Trend'}
            </CardTitle>
          </CardHeader>
          <CardContent className="h-[350px]">
             {stats.chartData.length > 0 ? (
               <ResponsiveContainer width="100%" height="100%">
                 <BarChart data={stats.chartData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                   <CartesianGrid strokeDasharray="3 3" opacity={0.1} vertical={false} />
                   <XAxis dataKey="label" fontSize={12} tickLine={false} axisLine={false} dy={10} />
                   <YAxis fontSize={12} tickLine={false} axisLine={false} tickFormatter={(value) => `$${value}`} />
                   <Tooltip 
                     cursor={{ fill: 'rgba(255,255,255,0.05)' }}
                     contentStyle={{ backgroundColor: '#0f172a', border: '1px solid #1e293b', borderRadius: '8px', color: '#fff', fontSize: '12px' }}
                     formatter={(value: number) => [`$${value.toFixed(2)}`, '']}
                   />
                   <Bar dataKey="revenue" name="Revenue" fill="#3b82f6" radius={[4, 4, 0, 0]} maxBarSize={50} />
                   <Bar dataKey="profit" name="Profit" fill="#10b981" radius={[4, 4, 0, 0]} maxBarSize={50} />
                 </BarChart>
               </ResponsiveContainer>
             ) : (
               <div className="h-full flex flex-col items-center justify-center text-muted-foreground bg-muted/10 rounded-xl border border-dashed border-border">
                 <AlertCircle className="w-10 h-10 mb-2 opacity-20" />
                 <p className="text-sm font-medium">No sales data for {rangeType === 'custom' ? customDate : 'this period'}</p>
                 <p className="text-xs opacity-60">Try selecting a different date range</p>
               </div>
             )}
          </CardContent>
        </Card>

        {/* Top Products */}
        <Card className="lg:col-span-1 border-border/50 shadow-sm h-full bg-card/50 backdrop-blur-sm">
          <CardHeader>
            <CardTitle className="text-base">Top Performers</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {stats.topProducts.map((p: any, i) => (
                <motion.div 
                  initial={{ opacity: 0, x: -10 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: i * 0.1 }}
                  key={i} 
                  className="flex items-center justify-between p-2.5 rounded-lg hover:bg-muted/50 transition-colors border border-transparent hover:border-border/50"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center font-bold text-xs text-primary shrink-0">
                      {i + 1}
                    </div>
                    <div className="overflow-hidden min-w-0">
                      <p className="font-medium text-sm truncate">{p.name}</p>
                      <p className="text-xs text-muted-foreground">{p.qty} sold</p>
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="font-bold text-emerald-500 text-sm">+${p.profit.toFixed(2)}</p>
                    <p className="text-[10px] text-muted-foreground">
                      {p.revenue > 0 ? ((p.profit / p.revenue) * 100).toFixed(0) : 0}% margin
                    </p>
                  </div>
                </motion.div>
              ))}
              {stats.topProducts.length === 0 && (
                <div className="h-40 flex flex-col items-center justify-center text-muted-foreground opacity-50">
                  <PieChart className="w-8 h-8 mb-2" />
                  <p className="text-xs">No data available</p>
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
};

const StatCard = ({ title, value, icon: Icon, color }: any) => (
  <motion.div 
    initial={{ opacity: 0, y: 10 }} 
    animate={{ opacity: 1, y: 0 }} 
    className="bg-card border border-border/50 rounded-xl p-5 shadow-sm hover:shadow-md transition-all hover:border-border"
  >
    <div className="flex justify-between items-start">
      <div>
        <p className="text-[11px] font-bold text-muted-foreground uppercase tracking-wider">{title}</p>
        <h3 className="text-2xl font-bold mt-1 tracking-tight text-foreground">{value}</h3>
      </div>
      <div className={cn("p-2.5 rounded-xl", color)}>
        <Icon className="w-5 h-5" />
      </div>
    </div>
  </motion.div>
);