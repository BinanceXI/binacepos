import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { 
  startOfDay, endOfDay, subDays, startOfMonth, startOfYear, 
  endOfMonth, format, parseISO
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
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { toast } from 'sonner';
import { 
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, BarChart, Bar 
} from 'recharts';
import { cn } from '@/lib/utils';
import { usePOS } from '@/contexts/POSContext';
import { listExpenses } from '@/lib/expenses';
import { listLocalServiceBookings, type LocalServiceBooking } from '@/lib/serviceBookings';
import { readScopedJSON, resolveTenantScope, tenantScopeKey, writeScopedJSON } from '@/lib/tenantScope';
import { isLikelyAuthError } from '@/lib/supabaseSession';
import {
  calculateMonthExpenseTotals,
  calculateSalesStats,
  inRange,
  mergeOrdersForMetrics,
  offlineQueueToOrders,
  readOrdersCache,
  sumOrdersRevenue,
  type OrderRow,
  type SalesRangeType,
  upsertOrdersCache,
} from '@/core/reports/reportMetrics';
import {
  REPORTS_OFFLINE_BANNER,
  requireAuthedSessionOrOfflineBanner,
} from '@/core/auth-gates/reportsSessionGate';

async function fetchOrdersRemote(startISO: string, endISO: string): Promise<OrderRow[]> {
  const withProfiles = await supabase
    .from('orders')
    .select(
      `
        id,
        receipt_id,
        receipt_number,
        total_amount,
        payment_method,
        status,
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
        receipt_id,
        receipt_number,
        total_amount,
        payment_method,
        status,
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
          receipt_id,
          receipt_number,
          total_amount,
          payment_method,
          status,
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

function normalizePaymentMethod(raw: string | null | undefined) {
  const method = String(raw || "cash").trim().toLowerCase();
  if (method.includes("card") || method.includes("swipe") || method.includes("pos")) return "card";
  if (method.includes("eco") || method.includes("mobile")) return "ecocash";
  return "cash";
}

function normalizeStatus(raw: string | null | undefined) {
  return String(raw || "completed").trim().toLowerCase();
}

export const ReportsPage = () => {
  const { currentUser } = usePOS();
  const isAdmin = String(currentUser?.role || "").toLowerCase() === "admin";
  const staffSelfId = String(currentUser?.id || "");
  const REPORT_PREFS_KEY = "binancexi_reports_prefs_v1";
  const scope = useMemo(
    () =>
      resolveTenantScope(
        currentUser
          ? {
              id: currentUser.id,
              business_id: currentUser.business_id,
            }
          : null
      ),
    [currentUser?.id, currentUser?.business_id]
  );
  const scopeKey = useMemo(() => tenantScopeKey(scope) || "global", [scope?.businessId, scope?.userId]);

  const [isOnline, setIsOnline] = useState(() => navigator.onLine);
  const reportPrefs = useMemo(
    () =>
      readScopedJSON<{
        rangeType?: 'today' | 'week' | 'month' | 'year' | 'custom';
        from?: string;
        to?: string;
        staffFilter?: string;
      }>(REPORT_PREFS_KEY, {}, { scope, migrateLegacy: true }),
    [scope?.businessId, scope?.userId]
  );
  const [rangeType, setRangeType] = useState<'today' | 'week' | 'month' | 'year' | 'custom'>(
    reportPrefs.rangeType || 'today'
  );
  const [dateRange, setDateRange] = useState<{ from: Date | undefined; to: Date | undefined }>(() => ({
    from: reportPrefs.from ? new Date(reportPrefs.from) : new Date(),
    to: reportPrefs.to ? new Date(reportPrefs.to) : new Date(),
  }));
  const [staffFilter, setStaffFilter] = useState<string>(reportPrefs.staffFilter || "all");
  const [offlineBanner, setOfflineBanner] = useState<string | null>(null);

  const updateOfflineBanner = useCallback((next: string | null) => {
    setOfflineBanner((prev) => (prev === next ? prev : next));
  }, []);

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

  const { data: staffOptions = [] } = useQuery({
    queryKey: ["reportsStaffOptions", scopeKey],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("profiles")
        .select("id, full_name, role, active")
        .eq("active", true)
        .in("role", ["admin", "cashier"])
        .order("full_name", { ascending: true });
      if (error) throw error;
      return (data || []) as Array<{ id: string; full_name: string | null; role: string | null; active: boolean | null }>;
    },
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: true,
  });

  useEffect(() => {
    if (isAdmin) {
      setStaffFilter((prev) => (prev ? prev : "all"));
      return;
    }
    if (staffSelfId) setStaffFilter(staffSelfId);
  }, [isAdmin, staffSelfId]);

  useEffect(() => {
    writeScopedJSON(
      REPORT_PREFS_KEY,
      {
        rangeType,
        from: dateRange.from?.toISOString() || null,
        to: dateRange.to?.toISOString() || null,
        staffFilter,
      },
      { scope }
    );
  }, [scope?.businessId, scope?.userId, rangeType, dateRange.from, dateRange.to, staffFilter]);

  // --- P4 Widget: This month (Revenue vs Expenses) ---
  const monthRange = useMemo(() => {
    const now = new Date();
    return {
      from: startOfMonth(now).toISOString(),
      to: endOfMonth(now).toISOString(),
    };
  }, []);

  const { data: monthOrders = [] } = useQuery({
    queryKey: ['p5MonthOrders', scopeKey, monthRange.from, monthRange.to, isOnline],
    queryFn: async () => {
      const start = parseISO(monthRange.from);
      const end = parseISO(monthRange.to);

      const queued = offlineQueueToOrders(scope).filter((o) => inRange(o.created_at, start, end));
      const cached = readOrdersCache(scope).filter((o) => inRange(o.created_at, start, end));
      const fallbackRows = mergeOrdersForMetrics(cached, queued);

      const gate = await requireAuthedSessionOrOfflineBanner({ isOnline });
      if (gate.mode === 'offline') {
        updateOfflineBanner(gate.banner);
        return fallbackRows;
      }

      try {
        const remote = await fetchOrdersRemote(monthRange.from, monthRange.to);
        upsertOrdersCache(scope, remote);
        updateOfflineBanner(null);
        return mergeOrdersForMetrics(remote, queued);
      } catch (e) {
        console.warn('[reports] month fetch failed, using cache fallback:', e);
        if (isLikelyAuthError(e)) updateOfflineBanner(REPORTS_OFFLINE_BANNER);
        else if (!navigator.onLine) updateOfflineBanner(REPORTS_OFFLINE_BANNER);
        return fallbackRows;
      }
    },
    staleTime: 1000 * 60 * 5,
    refetchOnWindowFocus: false,
    refetchOnReconnect: true,
  });

  const monthRevenue = useMemo(
    () => sumOrdersRevenue(monthOrders || []),
    [monthOrders]
  );

  const { data: monthExpenses = [] } = useQuery({
    queryKey: ['p4MonthExpenses', monthRange.from, monthRange.to],
    queryFn: async () => listExpenses(monthRange),
    staleTime: 0,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });

  const monthExpenseTotals = useMemo(
    () => calculateMonthExpenseTotals(monthExpenses as any[], monthRevenue),
    [monthExpenses, monthRevenue]
  );

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
    queryKey: ['salesReport', scopeKey, rangeType, dateRange, isOnline],
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

      const queued = offlineQueueToOrders(scope).filter((o) => inRange(o.created_at, start, end));
      const cached = readOrdersCache(scope).filter((o) => inRange(o.created_at, start, end));
      const fallbackRows = mergeOrdersForMetrics(cached, queued);

      const gate = await requireAuthedSessionOrOfflineBanner({ isOnline });
      if (gate.mode === 'offline') {
        updateOfflineBanner(gate.banner);
        return fallbackRows;
      }

      try {
        const remote = await fetchOrdersRemote(start.toISOString(), end.toISOString());
        upsertOrdersCache(scope, remote);
        updateOfflineBanner(null);
        return mergeOrdersForMetrics(remote, queued);
      } catch (e) {
        console.warn('[reports] sales fetch failed, using cache fallback:', e);
        if (isLikelyAuthError(e)) updateOfflineBanner(REPORTS_OFFLINE_BANNER);
        else if (!navigator.onLine) updateOfflineBanner(REPORTS_OFFLINE_BANNER);
        return fallbackRows;
      }
    },
    staleTime: 1000 * 60 * 5 // Cache for 5 mins
  });

  const effectiveStaffFilter = isAdmin ? staffFilter : staffSelfId;
  const filteredSalesData = useMemo(() => {
    const rows = (salesData as OrderRow[]) || [];
    if (!effectiveStaffFilter || effectiveStaffFilter === "all") return rows;
    return rows.filter((row) => String(row.cashier_id || "") === effectiveStaffFilter);
  }, [salesData, effectiveStaffFilter]);

  // --- 2. CALCULATE METRICS ---
  const stats = useMemo(
    () => calculateSalesStats(filteredSalesData as OrderRow[], rangeType as SalesRangeType),
    [filteredSalesData, rangeType]
  );

  const staffDrilldown = useMemo(() => {
    let grossSales = 0;
    let voidCount = 0;
    let voidAmount = 0;
    let refundCount = 0;
    let refundAmount = 0;
    let serviceRevenue = 0;
    let serviceCompletions = 0;

    const paymentSplit = { cash: 0, card: 0, ecocash: 0 };

    for (const row of filteredSalesData as OrderRow[]) {
      const amount = Number((row as any)?.total_amount || 0);
      const status = normalizeStatus((row as any)?.status);
      const paymentMethod = normalizePaymentMethod((row as any)?.payment_method);

      grossSales += amount;

      if (status.includes("void")) {
        voidCount += 1;
        voidAmount += amount;
        continue;
      }
      if (status.includes("refund")) {
        refundCount += 1;
        refundAmount += amount;
        continue;
      }

      paymentSplit[paymentMethod] += amount;
      if (String((row as any)?.sale_type || "") === "service") {
        serviceRevenue += amount;
        if ((row as any)?.booking_id) serviceCompletions += 1;
      }
    }

    const netSales = grossSales - voidAmount - refundAmount;
    const transactions = filteredSalesData.length;
    const avgTicket = transactions > 0 ? netSales / transactions : 0;

    return {
      grossSales,
      netSales,
      transactions,
      avgTicket,
      voidCount,
      voidAmount,
      refundCount,
      refundAmount,
      serviceRevenue,
      serviceCompletions,
      paymentSplit,
    };
  }, [filteredSalesData]);

  const receiptRows = useMemo(
    () =>
      [...(filteredSalesData as OrderRow[])].sort((a, b) =>
        String((b as any).created_at).localeCompare(String((a as any).created_at))
      ),
    [filteredSalesData]
  );

  const handleExportCSV = () => {
    const csvContent = [
      ["Date", "Receipt Number", "Receipt ID", "Cashier", "Total", "Method", "Status", "Sale Type"],
      ...receiptRows.map((o: any) => [
        format(parseISO(o.created_at), "yyyy-MM-dd HH:mm"),
        o.receipt_number || "",
        o.receipt_id || o.id,
        o.profiles?.full_name || "Unknown",
        Number(o.total_amount || 0).toFixed(2),
        o.payment_method || "cash",
        o.status || "completed",
        o.sale_type || "product",
      ]),
    ]
      .map((entry) => entry.join(","))
      .join("\n");

    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.setAttribute("href", url);
    link.setAttribute("download", `staff_report_${rangeType}_${effectiveStaffFilter || "all"}.csv`);
    document.body.appendChild(link);
    link.click();
    toast.success("Report downloaded");
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

          {isAdmin ? (
            <Select value={staffFilter} onValueChange={setStaffFilter}>
              <SelectTrigger className="w-[220px] bg-card h-9">
                <Users className="w-4 h-4 mr-2 text-muted-foreground" />
                <SelectValue placeholder="All staff" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Staff</SelectItem>
                {staffOptions.map((staff) => (
                  <SelectItem key={staff.id} value={staff.id}>
                    {staff.full_name || "Staff"} ({String(staff.role || "cashier")})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <Badge variant="outline" className="h-9 px-3 inline-flex items-center gap-2">
              <Users className="w-4 h-4" /> My Sales Only
            </Badge>
          )}

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

          <Button variant="outline" className="gap-2 h-9" onClick={handleExportCSV}>
            <Download className="w-4 h-4" />
            <span className="hidden sm:inline">Export</span>
          </Button>
        </div>
      </div>

      {offlineBanner ? (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          {offlineBanner}
        </div>
      ) : null}

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
	          {offlineBanner && (
	            <div className="text-xs text-muted-foreground">{offlineBanner}</div>
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

      <Card className="border-border/50 shadow-sm">
        <CardHeader className="pb-3">
          <CardTitle className="text-base font-semibold">Staff Drilldown</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-8 gap-3">
            <div className="rounded-xl border bg-card p-3">
              <div className="text-xs text-muted-foreground">Gross Sales</div>
              <div className="text-lg font-bold">${staffDrilldown.grossSales.toFixed(2)}</div>
            </div>
            <div className="rounded-xl border bg-card p-3">
              <div className="text-xs text-muted-foreground">Net Sales</div>
              <div className="text-lg font-bold">${staffDrilldown.netSales.toFixed(2)}</div>
            </div>
            <div className="rounded-xl border bg-card p-3">
              <div className="text-xs text-muted-foreground">Transactions</div>
              <div className="text-lg font-bold">{staffDrilldown.transactions}</div>
            </div>
            <div className="rounded-xl border bg-card p-3">
              <div className="text-xs text-muted-foreground">Avg Ticket</div>
              <div className="text-lg font-bold">${staffDrilldown.avgTicket.toFixed(2)}</div>
            </div>
            <div className="rounded-xl border bg-card p-3">
              <div className="text-xs text-muted-foreground">Voided</div>
              <div className="text-lg font-bold">{staffDrilldown.voidCount}</div>
              <div className="text-[11px] text-muted-foreground">${staffDrilldown.voidAmount.toFixed(2)}</div>
            </div>
            <div className="rounded-xl border bg-card p-3">
              <div className="text-xs text-muted-foreground">Refunded</div>
              <div className="text-lg font-bold">{staffDrilldown.refundCount}</div>
              <div className="text-[11px] text-muted-foreground">${staffDrilldown.refundAmount.toFixed(2)}</div>
            </div>
            <div className="rounded-xl border bg-card p-3">
              <div className="text-xs text-muted-foreground">Service Revenue</div>
              <div className="text-lg font-bold">${staffDrilldown.serviceRevenue.toFixed(2)}</div>
            </div>
            <div className="rounded-xl border bg-card p-3">
              <div className="text-xs text-muted-foreground">Service Completions</div>
              <div className="text-lg font-bold">{staffDrilldown.serviceCompletions}</div>
            </div>
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
                <p className="text-lg font-bold text-primary">${staffDrilldown.paymentSplit.cash.toFixed(2)}</p>
              </div>
              <div className="p-4 rounded-xl bg-blue-500/10 border border-blue-500/20 text-center">
                <CreditCard className="w-6 h-6 mx-auto mb-2 text-blue-500" />
                <p className="text-xs text-muted-foreground uppercase">Card</p>
                <p className="text-lg font-bold text-blue-500">${staffDrilldown.paymentSplit.card.toFixed(2)}</p>
              </div>
              <div className="p-4 rounded-xl bg-indigo-500/10 border border-indigo-500/20 text-center">
                <Smartphone className="w-6 h-6 mx-auto mb-2 text-indigo-500" />
                <p className="text-xs text-muted-foreground uppercase">EcoCash</p>
                <p className="text-lg font-bold text-indigo-500">${staffDrilldown.paymentSplit.ecocash.toFixed(2)}</p>
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

      <Card className="shadow-sm border-border/50">
        <CardHeader>
          <CardTitle className="text-base font-semibold">Receipt Drilldown</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Receipt</TableHead>
                <TableHead>Cashier</TableHead>
                <TableHead>Method</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Total</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {receiptRows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-muted-foreground">
                    No receipts in this filter.
                  </TableCell>
                </TableRow>
              ) : (
                receiptRows.slice(0, 200).map((row: any) => {
                  const status = normalizeStatus(row.status);
                  return (
                    <TableRow key={row.id}>
                      <TableCell className="text-xs">
                        {format(parseISO(row.created_at), "yyyy-MM-dd HH:mm")}
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {row.receipt_number || row.receipt_id || row.id}
                      </TableCell>
                      <TableCell>{row.profiles?.full_name || "Staff"}</TableCell>
                      <TableCell className="capitalize">{normalizePaymentMethod(row.payment_method)}</TableCell>
                      <TableCell>
                        <Badge
                          variant={
                            status.includes("void") || status.includes("refund")
                              ? "destructive"
                              : "secondary"
                          }
                        >
                          {row.status || "completed"}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right font-medium">
                        ${Number(row.total_amount || 0).toFixed(2)}
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
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
