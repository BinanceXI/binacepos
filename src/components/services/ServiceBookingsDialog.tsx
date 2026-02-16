import { useEffect, useMemo, useState } from "react";
import { CalendarPlus, ClipboardList, CheckCircle2, Ban } from "lucide-react";
import type { CartItem, Product } from "@/types/pos";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import {
  listLocalServiceBookings,
  newServiceBookingId,
  normalizeMoney,
  pullRecentServiceBookings,
  pushUnsyncedServiceBookings,
  type LocalServiceBooking,
  type ServiceBookingStatus,
  upsertLocalServiceBooking,
} from "@/lib/serviceBookings";
import { toast } from "sonner";

type SaleType = "product" | "service";
type PaymentMethod = "cash" | "card" | "ecocash";

export type SaleMeta = {
  receiptId: string;
  receiptNumber: string;
  timestamp: string;
  saleType: SaleType;
  bookingId?: string | null;
};

export type CreateSaleFn = (args: {
  items: CartItem[];
  payments: { method: string; amount: number }[];
  total: number;
  meta: SaleMeta;
  customerName?: string;
}) => Promise<void>;

export type PrintSaleFn = (args: {
  cart: CartItem[];
  total: number;
  paymentMethod: string;
  customerName: string;
  receiptId: string;
  receiptNumber: string;
  timestamp: string;
}) => void;

function toDatetimeLocalValue(d: Date) {
  const pad = (n: number) => String(n).padStart(2, "0");
  const yyyy = d.getFullYear();
  const mm = pad(d.getMonth() + 1);
  const dd = pad(d.getDate());
  const hh = pad(d.getHours());
  const mi = pad(d.getMinutes());
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}`;
}

function formatLocal(iso: string) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

function newLineId() {
  return `line-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function normalizeServiceName(name: unknown) {
  return String(name || "").trim().toLowerCase();
}

function makeReceiptId() {
  // @ts-ignore
  return globalThis.crypto?.randomUUID?.() ?? `rcpt-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
function makeReceiptNumber() {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const y = d.getFullYear();
  const m = pad(d.getMonth() + 1);
  const day = pad(d.getDate());
  const hh = pad(d.getHours());
  const mm = pad(d.getMinutes());
  const ss = pad(d.getSeconds());
  const rand = Math.random().toString(16).slice(2, 6).toUpperCase();
  return `TM-${y}${m}${day}-${hh}${mm}${ss}-${rand}`;
}

export type ServiceBookingsDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: "new" | "list";
  services: Product[];
  suggested?: {
    serviceId?: string;
    customerName?: string;
    totalPrice?: number;
  };
  onCreateSale: CreateSaleFn;
  onPrintSale: PrintSaleFn;
  onAfterCreateBooking?: () => void;
};

export function ServiceBookingsDialog({
  open,
  onOpenChange,
  mode,
  services,
  suggested,
  onCreateSale,
  onPrintSale,
  onAfterCreateBooking,
}: ServiceBookingsDialogProps) {
  const [tab, setTab] = useState<"new" | "list">(mode);
  const [bookings, setBookings] = useState<LocalServiceBooking[]>([]);

  // NEW booking form state
  const [serviceId, setServiceId] = useState<string>(suggested?.serviceId || "");
  const [customerName, setCustomerName] = useState<string>(suggested?.customerName || "");
  const [bookingDateTimeLocal, setBookingDateTimeLocal] = useState<string>(() =>
    toDatetimeLocalValue(new Date(Date.now() + 60 * 60 * 1000))
  );
  const [totalPriceRaw, setTotalPriceRaw] = useState<string>(
    suggested?.totalPrice != null ? String(suggested.totalPrice) : ""
  );
  const [depositRaw, setDepositRaw] = useState<string>("0");
  const [depositMethod, setDepositMethod] = useState<PaymentMethod>("cash");
  const [submitting, setSubmitting] = useState(false);

  // COMPLETE flow state
  const [completeOpen, setCompleteOpen] = useState(false);
  const [completeTarget, setCompleteTarget] = useState<LocalServiceBooking | null>(null);
  const [completeMethod, setCompleteMethod] = useState<PaymentMethod>("cash");
  const [completing, setCompleting] = useState(false);

  const serviceById = useMemo(() => new Map(services.map((s) => [s.id, s])), [services]);
  const serviceByName = useMemo(
    () =>
      new Map(
        services
          .map((s) => [normalizeServiceName(s.name), s] as const)
          .filter(([name]) => !!name)
      ),
    [services]
  );
  const selectedService = serviceId ? serviceById.get(serviceId) : undefined;

  useEffect(() => {
    if (!open) return;
    setTab(mode);
  }, [open, mode]);

  useEffect(() => {
    if (!open) return;
    setServiceId(suggested?.serviceId || "");
    setCustomerName(suggested?.customerName || "");
    setTotalPriceRaw(suggested?.totalPrice != null ? String(suggested.totalPrice) : "");
  }, [open, suggested?.serviceId, suggested?.customerName, suggested?.totalPrice]);

  const reloadBookings = async () => {
    const local = await listLocalServiceBookings();
    setBookings(local);
  };

  useEffect(() => {
    if (!open) return;
    if (tab !== "list") return;

    (async () => {
      try {
        await reloadBookings();
        if (navigator.onLine) {
          await pullRecentServiceBookings(30);
          await pushUnsyncedServiceBookings();
          await reloadBookings();
        }
      } catch (e: any) {
        toast.error(e?.message || "Failed to load bookings");
      }
    })();
  }, [open, tab]);

  const depositAmount = normalizeMoney(depositRaw);
  const totalPrice = normalizeMoney(totalPriceRaw);
  const remainingFor = (b: LocalServiceBooking) =>
    Math.max(0, normalizeMoney((b.total_price || 0) - (b.deposit_amount || 0)));

  const createBooking = async () => {
    if (!selectedService) {
      toast.error("Select a service");
      return;
    }

    const dt = new Date(bookingDateTimeLocal);
    if (Number.isNaN(dt.getTime())) {
      toast.error("Select a valid booking date/time");
      return;
    }

    const total = normalizeMoney(totalPrice);
    const dep = normalizeMoney(depositAmount);

    if (total <= 0) {
      toast.error("Total price must be greater than 0");
      return;
    }
    if (dep < 0 || dep > total) {
      toast.error("Deposit must be between 0 and total");
      return;
    }

    const nowIso = new Date().toISOString();
    const id = newServiceBookingId();

    const booking: LocalServiceBooking = {
      id,
      service_id: selectedService.id,
      service_name: selectedService.name,
      customer_name: customerName.trim() ? customerName.trim() : null,
      booking_date_time: dt.toISOString(),
      deposit_amount: dep,
      total_price: total,
      status: "booked",
      created_at: nowIso,
      updated_at: nowIso,
      synced: false,
    };

    setSubmitting(true);
    try {
      await upsertLocalServiceBooking(booking);
      if (navigator.onLine) await pushUnsyncedServiceBookings();

      if (dep > 0) {
        const receiptId = makeReceiptId();
        const receiptNumber = makeReceiptNumber();
        const timestamp = new Date().toISOString();

        const item: CartItem = {
          lineId: newLineId(),
          product: selectedService as any,
          quantity: 1,
          discount: 0,
          discountType: "percentage",
          customDescription: `Deposit for booking: ${formatLocal(booking.booking_date_time)}`,
          customPrice: dep,
        } as any;

        await onCreateSale({
          items: [item],
          payments: [{ method: depositMethod, amount: dep }],
          total: dep,
          meta: {
            receiptId,
            receiptNumber,
            timestamp,
            saleType: "service",
            bookingId: booking.id,
          },
          customerName: booking.customer_name || "",
        });

        onPrintSale({
          cart: [item],
          total: dep,
          paymentMethod: depositMethod,
          customerName: booking.customer_name || "",
          receiptId,
          receiptNumber,
          timestamp,
        });
      }

      toast.success("Booking created");
      onAfterCreateBooking?.();
      onOpenChange(false);
      setDepositRaw("0");
    } catch (e: any) {
      toast.error(e?.message || "Failed to create booking");
    } finally {
      setSubmitting(false);
    }
  };

  const updateStatus = async (b: LocalServiceBooking, next: ServiceBookingStatus) => {
    const updated: LocalServiceBooking = {
      ...b,
      status: next,
      synced: false,
      lastError: undefined,
      updated_at: new Date().toISOString(),
    };
    await upsertLocalServiceBooking(updated);
    if (navigator.onLine) await pushUnsyncedServiceBookings();
    await reloadBookings();
  };

  const beginComplete = (b: LocalServiceBooking) => {
    setCompleteTarget(b);
    setCompleteMethod("cash");
    setCompleteOpen(true);
  };

  const confirmComplete = async () => {
    if (!completeTarget) return;

    const remaining = remainingFor(completeTarget);
    setCompleting(true);
    try {
      if (remaining > 0) {
        const receiptId = makeReceiptId();
        const receiptNumber = makeReceiptNumber();
        const timestamp = new Date().toISOString();

        const svc: Product | undefined =
          serviceById.get(completeTarget.service_id) ||
          serviceByName.get(normalizeServiceName(completeTarget.service_name));
        const fallbackProductId =
          svc?.id || String(completeTarget.service_id || "").trim() || completeTarget.id;
        const product =
          svc ||
          ({
            id: fallbackProductId,
            name: completeTarget.service_name,
            price: remaining,
            category: "service",
            type: "service",
          } as any);

        const item: CartItem = {
          lineId: newLineId(),
          product: product as any,
          quantity: 1,
          discount: 0,
          discountType: "percentage",
          customDescription: `Balance for booking: ${formatLocal(completeTarget.booking_date_time)}`,
          customPrice: remaining,
        } as any;

        await onCreateSale({
          items: [item],
          payments: [{ method: completeMethod, amount: remaining }],
          total: remaining,
          meta: {
            receiptId,
            receiptNumber,
            timestamp,
            saleType: "service",
            bookingId: completeTarget.id,
          },
          customerName: completeTarget.customer_name || "",
        });

        onPrintSale({
          cart: [item],
          total: remaining,
          paymentMethod: completeMethod,
          customerName: completeTarget.customer_name || "",
          receiptId,
          receiptNumber,
          timestamp,
        });
      }

      await updateStatus(completeTarget, "completed");
      toast.success("Booking completed");
      setCompleteOpen(false);
      setCompleteTarget(null);
    } catch (e: any) {
      toast.error(e?.message || "Failed to complete booking");
    } finally {
      setCompleting(false);
    }
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ClipboardList className="w-5 h-5 text-primary" /> Service Bookings
            </DialogTitle>
          </DialogHeader>

          <div className="flex gap-2 mb-4">
            <Button
              type="button"
              variant={tab === "new" ? "default" : "outline"}
              className="gap-2"
              onClick={() => setTab("new")}
            >
              <CalendarPlus className="w-4 h-4" /> New Booking
            </Button>
            <Button
              type="button"
              variant={tab === "list" ? "default" : "outline"}
              className="gap-2"
              onClick={() => setTab("list")}
            >
              <ClipboardList className="w-4 h-4" /> Bookings List
            </Button>
          </div>

          {tab === "new" ? (
            <div className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div className="space-y-2">
                  <label className="text-sm font-medium">Service</label>
                  <Select value={serviceId} onValueChange={setServiceId}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select a service" />
                    </SelectTrigger>
                    <SelectContent>
                      {services.map((s) => (
                        <SelectItem key={s.id} value={s.id}>
                          {s.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <label className="text-sm font-medium">Booking date/time</label>
                  <Input
                    type="datetime-local"
                    value={bookingDateTimeLocal}
                    onChange={(e) => setBookingDateTimeLocal(e.target.value)}
                  />
                </div>

                <div className="space-y-2">
                  <label className="text-sm font-medium">Customer name (optional)</label>
                  <Input
                    value={customerName}
                    onChange={(e) => setCustomerName(e.target.value)}
                    placeholder="e.g. John"
                  />
                </div>

                <div className="space-y-2">
                  <label className="text-sm font-medium">Total price</label>
                  <Input
                    type="number"
                    inputMode="decimal"
                    value={totalPriceRaw}
                    onChange={(e) => setTotalPriceRaw(e.target.value)}
                    placeholder={selectedService ? String(selectedService.price) : "0"}
                  />
                </div>

                <div className="space-y-2">
                  <label className="text-sm font-medium">Deposit amount</label>
                  <Input
                    type="number"
                    inputMode="decimal"
                    value={depositRaw}
                    onChange={(e) => setDepositRaw(e.target.value)}
                    placeholder="0"
                  />
                </div>

                <div className={cn("space-y-2", depositAmount > 0 ? "" : "opacity-50")}>
                  <label className="text-sm font-medium">Deposit method</label>
                  <Select value={depositMethod} onValueChange={(v: any) => setDepositMethod(v)}>
                    <SelectTrigger disabled={depositAmount <= 0}>
                      <SelectValue placeholder="Select method" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="cash">Cash</SelectItem>
                      <SelectItem value="card">Card</SelectItem>
                      <SelectItem value="ecocash">EcoCash</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="flex justify-end gap-2">
                <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                  Close
                </Button>
                <Button type="button" onClick={createBooking} disabled={submitting}>
                  {submitting ? "Saving..." : "Create Booking"}
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-3 max-h-[60vh] overflow-auto pr-1">
              {bookings.length === 0 ? (
                <div className="text-sm text-muted-foreground">No bookings yet.</div>
              ) : (
                bookings.map((b) => {
                  const remaining = remainingFor(b);
                  return (
                    <div key={b.id} className="border border-border rounded-xl p-3 bg-card">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="font-semibold truncate">{b.service_name}</div>
                          <div className="text-xs text-muted-foreground">
                            {b.customer_name || "Walk-in"} • {formatLocal(b.booking_date_time)}
                          </div>
                        </div>

                        <div
                          className={cn(
                            "text-[11px] px-2 py-1 rounded-full border",
                            b.status === "booked" && "border-blue-500/30 bg-blue-500/10 text-blue-400",
                            b.status === "completed" && "border-emerald-500/30 bg-emerald-500/10 text-emerald-400",
                            b.status === "cancelled" && "border-zinc-500/30 bg-zinc-500/10 text-zinc-400"
                          )}
                        >
                          {b.status}
                        </div>
                      </div>

                      <div className="mt-2 text-sm grid grid-cols-3 gap-2">
                        <div>
                          <div className="text-[11px] text-muted-foreground">Total</div>
                          <div className="font-medium">${normalizeMoney(b.total_price).toFixed(2)}</div>
                        </div>
                        <div>
                          <div className="text-[11px] text-muted-foreground">Deposit</div>
                          <div className="font-medium">${normalizeMoney(b.deposit_amount).toFixed(2)}</div>
                        </div>
                        <div>
                          <div className="text-[11px] text-muted-foreground">Remaining</div>
                          <div className="font-medium">${remaining.toFixed(2)}</div>
                        </div>
                      </div>

                      {!b.synced && (
                        <div className="mt-2 text-[11px] text-amber-500">
                          Pending sync{b.lastError ? ` • ${b.lastError}` : ""}
                        </div>
                      )}

                      {b.status === "booked" && (
                        <div className="mt-3 flex gap-2">
                          <Button size="sm" className="gap-2" onClick={() => beginComplete(b)}>
                            <CheckCircle2 className="w-4 h-4" /> Complete
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            className="gap-2"
                            onClick={async () => {
                              try {
                                await updateStatus(b, "cancelled");
                                toast.message("Booking cancelled");
                              } catch (e: any) {
                                toast.error(e?.message || "Failed to cancel booking");
                              }
                            }}
                          >
                            <Ban className="w-4 h-4" /> Cancel
                          </Button>
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={completeOpen} onOpenChange={setCompleteOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Complete Booking</DialogTitle>
          </DialogHeader>

          {completeTarget ? (
            <div className="space-y-4">
              <div className="text-sm">
                <div className="font-medium">{completeTarget.service_name}</div>
                <div className="text-xs text-muted-foreground">
                  {completeTarget.customer_name || "Walk-in"} • {formatLocal(completeTarget.booking_date_time)}
                </div>
              </div>

              <div className="rounded-xl border bg-muted/20 p-3">
                <div className="text-xs text-muted-foreground">Amount due</div>
                <div className="text-2xl font-bold">
                  ${remainingFor(completeTarget).toFixed(2)}
                </div>
              </div>

              {remainingFor(completeTarget) > 0 ? (
                <div className="space-y-2">
                  <label className="text-sm font-medium">Payment method</label>
                  <Select value={completeMethod} onValueChange={(v: any) => setCompleteMethod(v)}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select method" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="cash">Cash</SelectItem>
                      <SelectItem value="card">Card</SelectItem>
                      <SelectItem value="ecocash">EcoCash</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              ) : (
                <div className="text-xs text-muted-foreground">
                  No balance remaining — this will just mark the booking as completed.
                </div>
              )}

              <div className="flex justify-end gap-2">
                <Button type="button" variant="outline" onClick={() => setCompleteOpen(false)}>
                  Close
                </Button>
                <Button type="button" onClick={confirmComplete} disabled={completing}>
                  {completing ? "Saving..." : "Confirm"}
                </Button>
              </div>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
