import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { 
  startOfDay, endOfDay, subDays, startOfMonth, startOfYear, 
  endOfMonth, format, parseISO, isWithinInterval 
} from 'date-fns';
import { motion } from 'framer-motion';
import {
  Calendar as CalendarIcon, Download, TrendingUp, DollarSign, 
  ShoppingCart, Users, ArrowUpRight, ArrowDownRight, Loader2, 
  BarChart3, CreditCard, Banknote, Smartphone
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Calendar } from '@/components/ui/calendar';
import { toast } from 'sonner';
import { 
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, BarChart, Bar 
} from 'recharts';
import { cn } from '@/lib/utils';
import { listExpenses } from '@/lib/expenses';
import { listLocalServiceBookings, type LocalServiceBooking } from '@/lib/serviceBookings';

const OFFLINE_QUEUE_KEY = 'binancexi_offline_queue';
const ORDERS_CACHE_KEY = 'binancexi_orders_cache_v1';

type OrderItemRow = {
  quantity: number;
  price_at_sale: number;
  product_name: string;
  service_note?: string | null;
};

type OrderRow = {
  id: string;
  total_amount: number;
  payment_method: string | null;
  created_at: string;
  cashier_id?: string | null;
  sale_type?: string | null;
  booking_id?: string | null;
  profiles?: { full_name?: string | null } | null;
  order_items?: OrderItemRow[] | null;
};

function safeJSONParse<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function readOrdersCache(): OrderRow[] {
  return safeJSONParse<OrderRow[]>(localStorage.getItem(ORDERS_CACHE_KEY), []);
}

function writeOrdersCache(rows: OrderRow[]) {
  localStorage.setItem(ORDERS_CACHE_KEY, JSON.stringify(rows));
}

function upsertOrdersCache(rows: OrderRow[]) {
  const cur = readOrdersCache();
  const byId = new Map<string, OrderRow>();
  for (const o of cur) {
    if (o?.id) byId.set(String(o.id), o);
  }
  for (const o of rows) {
    if (o?.id) byId.set(String(o.id), o);
  }

  const merged = Array.from(byId.values()).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  const pruned = merged.slice(0, 3000);
  writeOrdersCache(pruned);
}

function offlineQueueToOrders(): OrderRow[] {
  const queue = safeJSONParse<any[]>(localStorage.getItem(OFFLINE_QUEUE_KEY), []);
  return (queue || [])
    .map((sale: any) => {
      const created_at = String(sale?.meta?.timestamp || new Date().toISOString());
      const items = Array.isArray(sale?.items) ? sale.items : [];
      const saleType =
        String(sale?.saleType || sale?.meta?.saleType || '').trim() ||
        (items.some((i: any) => i?.product?.type === 'service') ? 'service' : 'product');

      const bookingId = sale?.bookingId ?? sale?.meta?.bookingId ?? null;

      return {
        id: String(sale?.meta?.receiptId || `offline-${created_at}`),
        total_amount: Number(sale?.total || 0),
        payment_method: String(sale?.payments?.[0]?.method || 'cash'),
        created_at,
        sale_type: saleType,
        booking_id: bookingId ? String(bookingId) : null,
        profiles: { full_name: 'Offline' },
        order_items: items.map((i: any) => ({
          quantity: Number(i?.quantity || 0),
          price_at_sale: Number(i?.customPrice ?? i?.product?.price ?? 0),
          product_name: String(i?.product?.name || 'Unknown'),
          service_note: i?.customDescription ? String(i.customDescription) : null,
        })),
      } as OrderRow;
    })
    .filter(Boolean);
}

function inRange(iso: string, start: Date, end: Date) {
  try {
    return isWithinInterval(parseISO(iso), { start, end });
  } catch {
    return false;
  }
}

async function fetchOrdersRemote(startISO: string, endISO: string): Promise<OrderRow[]> {
  const withProfiles = await supabase
    .from('orders')
    .select(
      `
        id,
        total_amount,
        payment_method,
        created_at,
        cashier_id,
        sale_type,
        booking_id,
        profiles (full_name),
        order_items (
          quantity,
          price_at_sale,
          product_name,
          service_note
        )
      `
    )
    .gte('created_at', startISO)
    .lte('created_at', endISO)
    .order('created_at', { ascending: true });

  if (!withProfiles.error) return (withProfiles.data as any) || [];

  const withServiceNote = await supabase
    .from('orders')
    .select(
      `
        id,
        total_amount,
        payment_method,
        created_at,
        cashier_id,
        sale_type,
        booking_id,
        order_items (
          quantity,
          price_at_sale,
          product_name,
          service_note
        )
      `
    )
    .gte('created_at', startISO)
    .lte('created_at', endISO)
    .order('created_at', { ascending: true });

  let rows: any[] = [];
  if (withServiceNote.error) {
    const withoutServiceNote = await supabase
      .from('orders')
      .select(
        `
          id,
          total_amount,
          payment_method,
          created_at,
          cashier_id,
          sale_type,
          booking_id,
          order_items (
            quantity,
            price_at_sale,
            product_name
          )
        `
      )
      .gte('created_at', startISO)
      .lte('created_at', endISO)
      .order('created_at', { ascending: true });

    if (withoutServiceNote.error) throw withoutServiceNote.error;
    rows = (withoutServiceNote.data as any[]) || [];
  } else {
    rows = (withServiceNote.data as any[]) || [];
  }

  const cashierIds = Array.from(
    new Set(rows.map((o: any) => o?.cashier_id).filter(Boolean).map((id: string) => String(id)))
  );

  let cashierMap = new Map<string, string>();
  if (cashierIds.length > 0) {
    const { data: profs, error: profErr } = await supabase
      .from('profiles')
      .select('id,full_name')
      .in('id', cashierIds);

    if (!profErr) {
      cashierMap = new Map((profs || []).map((p: any) => [String(p.id), String(p.full_name || 'Staff')]));
    }
  }

  return rows.map((o: any) => ({
    ...o,
    profiles: { full_name: cashierMap.get(String(o.cashier_id || '')) || 'Staff' },
    order_items: (o.order_items || []).map((it: any) => ({
      ...it,
      service_note: it?.service_note ?? null,
    })),
  })) as OrderRow[];
}

export const ReportsPage = () => {
  const [isOnline, setIsOnline] = useState(() => navigator.onLine);
  const [rangeType, setRangeType] = useState<'today' | 'week' | 'month' | 'year' | 'custom'>('today');
  const [dateRange, setDateRange] = useState<{ from: Date | undefined; to: Date | undefined }>({
    from: new Date(),
    to: new Date(),
  });

  useEffect(() => {
    const onOn = () => setIsOnline(true);
    const onOff = () => setIsOnline(false);
    window.addEventListener('online', onOn);
    window.addEventListener('offline', onOff);
    return () => {
      window.removeEventListener('online', onOn);
      window.removeEventListener('offline', onOff);
    };
  }, []);

  // --- P4 Widget: This month (Revenue vs Expenses) ---
  const monthRange = useMemo(() => {
    const now = new Date();
    return {
      from: startOfMonth(now).toISOString(),
      to: endOfMonth(now).toISOString(),
    };
  }, []);

  const { data: monthOrders = [] } = useQuery({
    queryKey: ['p5MonthOrders', monthRange.from, monthRange.to, isOnline],
    queryFn: async () => {
      const start = parseISO(monthRange.from);
      const end = parseISO(monthRange.to);

      const queued = offlineQueueToOrders().filter((o) => inRange(o.created_at, start, end));
      const cached = readOrdersCache().filter((o) => inRange(o.created_at, start, end));

      if (!isOnline) {
        return [...cached, ...queued].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
      }

      try {
        const remote = await fetchOrdersRemote(monthRange.from, monthRange.to);
        upsertOrdersCache(remote);
        return [...remote, ...queued];
      } catch (e) {
        console.warn('[reports] month fetch failed, using cache fallback:', e);
        return [...cached, ...queued].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
      }
    },
    staleTime: 1000 * 60 * 5,
    refetchOnWindowFocus: false,
    refetchOnReconnect: true,
  });

  const monthRevenue = useMemo(
    () => (monthOrders || []).reduce((sum: number, o: any) => sum + Number(o.total_amount || 0), 0),
    [monthOrders]
  );

  const { data: monthExpenses = [] } = useQuery({
    queryKey: ['p4MonthExpenses', monthRange.from, monthRange.to],
    queryFn: async () => listExpenses(monthRange),
    staleTime: 0,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });

  const monthExpenseTotals = useMemo(() => {
    let expenses = 0;
    let drawings = 0;
    (monthExpenses || []).forEach((e: any) => {
      const amt = Number(e.amount || 0);
      if (e.expense_type === 'owner_draw' || e.expense_type === 'owner_drawing') drawings += amt;
      else expenses += amt;
    });
    const net = monthRevenue - (expenses + drawings);
    return { expenses, drawings, net };
  }, [monthExpenses, monthRevenue]);

  const { data: monthBookings = [] } = useQuery({
    queryKey: ['p5MonthBookings', monthRange.from, monthRange.to],
    queryFn: async () => {
      const all = await listLocalServiceBookings();
      return all || [];
    },
    staleTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: true,
  });

  const monthServiceTotals = useMemo(() => {
    const start = parseISO(monthRange.from);
    const end = parseISO(monthRange.to);

    let goodsRevenue = 0;
    let servicesRevenue = 0;
    let serviceDeposits = 0;
    let serviceBalances = 0;

    (monthOrders || []).forEach((o: any) => {
      const amount = Number(o.total_amount || 0);
      const saleType = String(o.sale_type || 'product');

      if (saleType === 'service') servicesRevenue += amount;
      else goodsRevenue += amount;

      if (saleType !== 'service') return;
      if (!o.booking_id) return;

      const notes = (o.order_items || [])
        .map((i: any) => String(i?.service_note || '').toLowerCase())
        .filter(Boolean);

      if (notes.some((n: string) => n.includes('deposit for booking'))) serviceDeposits += amount;
      else if (notes.some((n: string) => n.includes('balance for booking'))) serviceBalances += amount;
    });

    let bookingsCreated = 0;
    let bookingsCompleted = 0;
    (monthBookings || []).forEach((b: LocalServiceBooking) => {
      if (inRange(String(b.created_at || ''), start, end)) bookingsCreated += 1;
      if (b.status === 'completed' && inRange(String(b.updated_at || b.created_at || ''), start, end)) bookingsCompleted += 1;
    });

    return { goodsRevenue, servicesRevenue, serviceDeposits, serviceBalances, bookingsCreated, bookingsCompleted };
  }, [monthBookings, monthOrders, monthRange.from, monthRange.to]);

  // --- 1. FETCH REAL DATA ---
  const { data: salesData = [], isLoading } = useQuery({
    queryKey: ['salesReport', rangeType, dateRange, isOnline],
    queryFn: async () => {
      const now = new Date();
      let start = startOfDay(now);
      let end = endOfDay(now);

      if (rangeType === 'week') start = subDays(now, 7);
      if (rangeType === 'month') start = startOfMonth(now);
      if (rangeType === 'year') start = startOfYear(now);
      if (rangeType === 'custom' && dateRange.from) {
        start = startOfDay(dateRange.from);
        end = endOfDay(dateRange.to || dateRange.from);
      }

      const queued = offlineQueueToOrders().filter((o) => inRange(o.created_at, start, end));
      const cached = readOrdersCache().filter((o) => inRange(o.created_at, start, end));

      // Offline-first: render from cached + queued sales
      if (!isOnline) {
        return [...cached, ...queued].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
      }

      try {
        const remote = await fetchOrdersRemote(start.toISOString(), end.toISOString());
        upsertOrdersCache(remote);
        return [...remote, ...queued];
      } catch (e) {
        console.warn('[reports] sales fetch failed, using cache fallback:', e);
        return [...cached, ...queued].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
      }
    },
    staleTime: 1000 * 60 * 5 // Cache for 5 mins
  });

  // --- 2. CALCULATE METRICS ---
  const stats = useMemo(() => {
    let totalRevenue = 0;
    let transactionCount = 0;
    const paymentMethods = { cash: 0, card: 0, ecocash: 0 };
    const cashierPerformance: Record<string, number> = {};
    const chartData: any[] = [];
    const productSales: Record<string, number> = {};

    // Grouping for Chart
    const timeMap: Record<string, number> = {};

    salesData.forEach((order: any) => {
      const amount = Number(order.total_amount);
      totalRevenue += amount;
      transactionCount++;

      // Payment Splits
      const method = order.payment_method?.toLowerCase() || 'cash';
      if (method.includes('card') || method.includes('swipe')) paymentMethods.card += amount;
      else if (method.includes('eco') || method.includes('mobile')) paymentMethods.ecocash += amount;
      else paymentMethods.cash += amount;

      // Cashier Stats
      const cashierName = order.profiles?.full_name || 'Unknown';
      cashierPerformance[cashierName] = (cashierPerformance[cashierName] || 0) + amount;

      // Product Stats
      order.order_items?.forEach((item: any) => {
        const pName = item.product_name || 'Unknown';
        productSales[pName] = (productSales[pName] || 0) + item.quantity;
      });

      // Chart Data Grouping
      const date = parseISO(order.created_at);
      let key = format(date, 'HH:00'); // Default Hourly
      if (rangeType === 'month' || rangeType === 'year' || rangeType === 'week') {
        key = format(date, 'MMM dd'); // Daily for longer ranges
      }
      timeMap[key] = (timeMap[key] || 0) + amount;
    });

    // Format Chart Data
    Object.keys(timeMap).forEach(key => {
      chartData.push({ name: key, value: timeMap[key] });
    });

    const avgTicket = transactionCount > 0 ? totalRevenue / transactionCount : 0;
    const topProducts = Object.entries(productSales)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 5)
      .map(([name, qty]) => ({ name, qty }));

    const topCashiers = Object.entries(cashierPerformance)
      .sort(([, a], [, b]) => b - a)
      .map(([name, total]) => ({ name, total }));

    return {
      totalRevenue,
      transactionCount,
      avgTicket,
      paymentMethods,
      chartData,
      topProducts,
      topCashiers
    };
  }, [salesData, rangeType]);

  const handleExportPDF = () => {
    // Simple CSV Export logic for now (Robust PDF usually requires heavy libraries)
    const csvContent = [
      ["Date", "Receipt ID", "Total", "Method", "Cashier"],
      ...salesData.map((o: any) => [
        format(parseISO(o.created_at), 'yyyy-MM-dd HH:mm'),
        o.id,
        o.total_amount,
        o.payment_method,
        o.profiles?.full_name || 'Unknown'
      ])
    ].map(e => e.join(",")).join("\n");

    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.setAttribute("href", url);
    link.setAttribute("download", `sales_report_${rangeType}.csv`);
    document.body.appendChild(link);
    link.click();
    toast.success("Report Downloaded");
  };

  if (isLoading) return <div className="flex h-screen items-center justify-center"><Loader2 className="animate-spin h-8 w-8 text-primary"/></div>;

  return (
    <div className="p-4 md:p-6 space-y-6 pb-20 bg-background min-h-screen">
      
      {/* HEADER & FILTERS */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Analytics Dashboard</h1>
          <p className="text-muted-foreground text-sm">Performance metrics & financial insights</p>
        </div>
        
        <div className="flex flex-wrap items-center gap-2">
          {/* Range Selector */}
          <Select value={rangeType} onValueChange={(val: any) => setRangeType(val)}>
            <SelectTrigger className="w-[140px] bg-card h-9">
              <CalendarIcon className="w-4 h-4 mr-2 text-muted-foreground" />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="today">Today</SelectItem>
              <SelectItem value="week">This Week</SelectItem>
              <SelectItem value="month">This Month</SelectItem>
              <SelectItem value="year">This Year</SelectItem>
              <SelectItem value="custom">Custom Range</SelectItem>
            </SelectContent>
          </Select>

          {/* Custom Date Picker */}
          {rangeType === 'custom' && (
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="outline" className="h-9 font-normal">
                  {dateRange?.from ? (
                    dateRange.to ? (
                      <>{format(dateRange.from, "LLL dd, y")} - {format(dateRange.to, "LLL dd, y")}</>
                    ) : (
                      format(dateRange.from, "LLL dd, y")
                    )
                  ) : (
                    <span>Pick a date</span>
                  )}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="end">
                <Calendar
                  initialFocus
                  mode="range"
                  defaultMonth={dateRange?.from}
                  selected={dateRange}
                  onSelect={(range: any) => setDateRange(range)}
                  numberOfMonths={2}
                />
              </PopoverContent>
            </Popover>
          )}

          <Button variant="outline" className="gap-2 h-9" onClick={handleExportPDF}>
            <Download className="w-4 h-4" />
            <span className="hidden sm:inline">Export</span>
          </Button>
        </div>
      </div>

      {/* P4: This month widget */}
      <Card className="border-border/50 shadow-sm">
        <CardHeader className="pb-3">
          <CardTitle className="text-base font-semibold">This month (Revenue vs Expenses)</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="rounded-xl border bg-card p-3">
              <div className="text-xs text-muted-foreground">Revenue</div>
              <div className="text-lg font-bold">${monthRevenue.toFixed(2)}</div>
            </div>
            <div className="rounded-xl border bg-card p-3">
              <div className="text-xs text-muted-foreground">Expenses</div>
              <div className="text-lg font-bold">${monthExpenseTotals.expenses.toFixed(2)}</div>
            </div>
            <div className="rounded-xl border bg-card p-3">
              <div className="text-xs text-muted-foreground">Owner drawings</div>
              <div className="text-lg font-bold">${monthExpenseTotals.drawings.toFixed(2)}</div>
            </div>
            <div className="rounded-xl border bg-card p-3">
              <div className="text-xs text-muted-foreground">Net</div>
              <div className={cn("text-lg font-bold", monthExpenseTotals.net >= 0 ? "text-emerald-500" : "text-red-500")}>
                ${monthExpenseTotals.net.toFixed(2)}
              </div>
            </div>
          </div>
        </CardContent>
	      </Card>

	      {/* P5: This month service breakdown */}
	      <Card className="border-border/50 shadow-sm">
	        <CardHeader className="pb-3">
	          <CardTitle className="text-base font-semibold">This month (Goods vs Services)</CardTitle>
	          {!isOnline && (
	            <div className="text-xs text-muted-foreground">Offline: showing cached + queued sales</div>
	          )}
	        </CardHeader>
	        <CardContent>
	          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
	            <div className="rounded-xl border bg-card p-3">
	              <div className="text-xs text-muted-foreground">Goods revenue</div>
	              <div className="text-lg font-bold">${monthServiceTotals.goodsRevenue.toFixed(2)}</div>
	            </div>
	            <div className="rounded-xl border bg-card p-3">
	              <div className="text-xs text-muted-foreground">Services revenue</div>
	              <div className="text-lg font-bold">${monthServiceTotals.servicesRevenue.toFixed(2)}</div>
	            </div>
	            <div className="rounded-xl border bg-card p-3">
	              <div className="text-xs text-muted-foreground">Service deposits</div>
	              <div className="text-lg font-bold">${monthServiceTotals.serviceDeposits.toFixed(2)}</div>
	            </div>
	            <div className="rounded-xl border bg-card p-3">
	              <div className="text-xs text-muted-foreground">Service balances</div>
	              <div className="text-lg font-bold">${monthServiceTotals.serviceBalances.toFixed(2)}</div>
	            </div>
	            <div className="rounded-xl border bg-card p-3">
	              <div className="text-xs text-muted-foreground">Bookings created</div>
	              <div className="text-lg font-bold">{monthServiceTotals.bookingsCreated}</div>
	            </div>
	            <div className="rounded-xl border bg-card p-3">
	              <div className="text-xs text-muted-foreground">Bookings completed</div>
	              <div className="text-lg font-bold">{monthServiceTotals.bookingsCompleted}</div>
	            </div>
	          </div>
	          <div className="mt-2 text-[11px] text-muted-foreground">
	            Uses <span className="font-mono">orders.sale_type</span> + <span className="font-mono">orders.booking_id</span>; deposits/balances are identified from booking payment notes.
	          </div>
	        </CardContent>
	      </Card>

	      {/* KPI STATS */}
	      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 md:gap-4">
	        <StatCard 
	          title="Total Revenue" 
	          value={`$${stats.totalRevenue.toLocaleString()}`} 
          icon={DollarSign} 
          trend="+12%" 
          color="text-primary bg-primary/10" 
        />
        <StatCard 
          title="Transactions" 
          value={stats.transactionCount.toString()} 
          icon={ShoppingCart} 
          trend="+5%" 
          color="text-blue-500 bg-blue-500/10" 
        />
        <StatCard 
          title="Avg. Ticket" 
          value={`$${stats.avgTicket.toFixed(2)}`} 
          icon={TrendingUp} 
          trend="-2%" 
          color="text-indigo-500 bg-indigo-500/10" 
        />
        <StatCard 
          title="Active Staff" 
          value={stats.topCashiers.length.toString()} 
          icon={Users} 
          trend="Stable" 
          color="text-sky-500 bg-sky-500/10" 
        />
      </div>

      {/* CHART SECTION */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        
        {/* Main Revenue Chart */}
        <Card className="lg:col-span-2 shadow-sm border-border/50 bg-card/50 backdrop-blur-sm">
          <CardHeader>
            <CardTitle className="text-base font-semibold flex items-center gap-2">
              <BarChart3 className="w-5 h-5 text-muted-foreground" />
              Revenue Trend
            </CardTitle>
          </CardHeader>
          <CardContent className="h-[300px] w-full">
            {stats.chartData.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={stats.chartData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id="colorValue" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#4169e1" stopOpacity={0.35}/>
                      <stop offset="95%" stopColor="#4169e1" stopOpacity={0}/>
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" opacity={0.1} vertical={false} />
                  <XAxis dataKey="name" fontSize={12} tickLine={false} axisLine={false} dy={10} />
                  <YAxis fontSize={12} tickLine={false} axisLine={false} tickFormatter={(value) => `$${value}`} />
                  <Tooltip 
                    contentStyle={{ backgroundColor: '#0a1b47', border: '1px solid #27408b', borderRadius: '8px', color: '#fff' }}
                    itemStyle={{ color: '#8fb1ff' }}
                    formatter={(value: number) => [`$${value.toFixed(2)}`, 'Revenue']}
                  />
                  <Area 
                    type="monotone" 
                    dataKey="value" 
                    stroke="#4169e1" 
                    strokeWidth={2}
                    fillOpacity={1} 
                    fill="url(#colorValue)" 
                  />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <div className="h-full flex flex-col items-center justify-center text-muted-foreground opacity-50">
                <BarChart3 className="w-10 h-10 mb-2" />
                <p>No sales data for this period</p>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Sales by Cashier (Vertical List) */}
        <Card className="shadow-sm border-border/50 bg-card/50 backdrop-blur-sm">
          <CardHeader>
            <CardTitle className="text-base font-semibold">Top Cashiers</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {stats.topCashiers.map((staff, i) => (
                <div key={i} className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-full bg-primary/12 border border-primary/25 flex items-center justify-center text-xs font-bold text-primary">
                      {staff.name.charAt(0)}
                    </div>
                    <span className="text-sm font-medium">{staff.name}</span>
                  </div>
                  <span className="font-mono font-bold text-sm">${staff.total.toFixed(2)}</span>
                </div>
              ))}
              {stats.topCashiers.length === 0 && (
                <p className="text-sm text-muted-foreground text-center py-4">No data available</p>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* BOTTOM ROW */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        
        {/* Payment Methods */}
        <Card className="shadow-sm border-border/50">
          <CardHeader>
            <CardTitle className="text-base font-semibold">Payment Methods</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-3 gap-4">
              <div className="p-4 rounded-xl bg-primary/10 border border-primary/20 text-center">
                <Banknote className="w-6 h-6 mx-auto mb-2 text-primary" />
                <p className="text-xs text-muted-foreground uppercase">Cash</p>
                <p className="text-lg font-bold text-primary">${stats.paymentMethods.cash.toFixed(0)}</p>
              </div>
              <div className="p-4 rounded-xl bg-blue-500/10 border border-blue-500/20 text-center">
                <CreditCard className="w-6 h-6 mx-auto mb-2 text-blue-500" />
                <p className="text-xs text-muted-foreground uppercase">Card</p>
                <p className="text-lg font-bold text-blue-500">${stats.paymentMethods.card.toFixed(0)}</p>
              </div>
              <div className="p-4 rounded-xl bg-indigo-500/10 border border-indigo-500/20 text-center">
                <Smartphone className="w-6 h-6 mx-auto mb-2 text-indigo-500" />
                <p className="text-xs text-muted-foreground uppercase">EcoCash</p>
                <p className="text-lg font-bold text-indigo-500">${stats.paymentMethods.ecocash.toFixed(0)}</p>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Top Selling Items */}
        <Card className="shadow-sm border-border/50">
          <CardHeader>
            <CardTitle className="text-base font-semibold">Top Selling Items</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {stats.topProducts.map((p, i) => (
                <div key={i} className="flex items-center justify-between p-2 rounded-lg hover:bg-muted/50 transition-colors">
                  <div className="flex items-center gap-3">
                    <span className="text-xs font-bold text-muted-foreground w-4">{i + 1}.</span>
                    <span className="text-sm font-medium truncate w-40">{p.name}</span>
                  </div>
                  <span className="text-xs bg-primary/10 text-primary px-2 py-1 rounded-full font-bold">
                    {p.qty} Sold
                  </span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
};

const StatCard = ({ title, value, icon: Icon, trend, color }: any) => (
  <motion.div 
    initial={{ opacity: 0, y: 10 }} 
    animate={{ opacity: 1, y: 0 }} 
    className="bg-card border border-border/50 rounded-xl p-5 shadow-sm hover:shadow-md transition-all relative overflow-hidden"
  >
    <div className="flex justify-between items-start relative z-10">
      <div>
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">{title}</p>
        <h3 className="text-2xl font-bold mt-2 tracking-tight">{value}</h3>
        {trend && (
          <div className="flex items-center gap-1 mt-1">
            {trend.includes('+') ? (
              <ArrowUpRight className="w-3 h-3 text-primary" />
            ) : trend.includes('-') ? (
              <ArrowDownRight className="w-3 h-3 text-muted-foreground" />
            ) : (
              <div className="w-3 h-3 rounded-full bg-primary/30" />
            )}
            <span
              className={cn(
                "text-xs font-bold",
                trend.includes('+')
                  ? "text-primary"
                  : trend.includes('-')
                    ? "text-muted-foreground"
                    : "text-primary/80"
              )}
            >
              {trend}
            </span>
          </div>
        )}
      </div>
      <div className={cn("p-2.5 rounded-xl", color)}>
        <Icon className="w-5 h-5" />
      </div>
    </div>
  </motion.div>
);
