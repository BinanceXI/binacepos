import { useEffect, useState, forwardRef, useImperativeHandle } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Banknote, CreditCard, Smartphone, Split, Pause, Receipt, CheckCircle2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { usePOS } from "@/contexts/POSContext";
import { cn } from "@/lib/utils";
import { PaymentMethod } from "@/types/pos";

interface PaymentPanelProps {
  subtotal: number;
  discount?: number;
  tax: number;
  total: number;
  onComplete?: (method: string) => void; // parent prints + saves order
}

export interface PaymentPanelRef {
  openPayment: () => void;
  closePayment: () => void; // ✅ ADDED (fixes your red)
  selectPaymentMethod: (index: number) => void;
}

const paymentMethods: {
  id: PaymentMethod;
  label: string;
  icon: any;
  color: string;
  shortcut: string;
}[] = [
  { id: "cash", label: "Cash", icon: Banknote, color: "bg-green-500/10 text-green-500 border-green-500/30", shortcut: "F4" },
  { id: "card", label: "Card", icon: CreditCard, color: "bg-blue-500/10 text-blue-500 border-blue-500/30", shortcut: "F5" },
  { id: "ecocash", label: "EcoCash", icon: Smartphone, color: "bg-pink-500/10 text-pink-500 border-pink-500/30", shortcut: "F6" },
  { id: "mixed", label: "Split", icon: Split, color: "bg-orange-500/10 text-orange-500 border-orange-500/30", shortcut: "F7" },
];

export const PaymentPanel = forwardRef<PaymentPanelRef, PaymentPanelProps>(
  ({ subtotal, discount = 0, tax, total, onComplete }, ref) => {
    const { cart, holdCurrentSale } = usePOS();

    const [selectedPayment, setSelectedPayment] = useState<PaymentMethod>("cash");
    const [showPaymentModal, setShowPaymentModal] = useState(false);
    const [showSuccessModal, setShowSuccessModal] = useState(false);
    const [cashReceived, setCashReceived] = useState("");

    const closePayment = () => {
      setShowPaymentModal(false);
      setCashReceived("");
    };

    useImperativeHandle(ref, () => ({
      openPayment: () => {
        if (cart.length > 0) {
          setSelectedPayment("cash");
          setShowPaymentModal(true);
        }
      },
      closePayment: () => closePayment(),
      selectPaymentMethod: (index: number) => {
        const method = paymentMethods[index]?.id;
        if (method && cart.length > 0) {
          setSelectedPayment(method);
          setShowPaymentModal(true);
        }
      },
    }));

    // ESC closes modal
    useEffect(() => {
      if (!showPaymentModal) return;

      const onKeyDown = (e: KeyboardEvent) => {
        if (e.key === "Escape") {
          e.preventDefault();
          closePayment();
        }
      };
      window.addEventListener("keydown", onKeyDown, { passive: false });
      return () => window.removeEventListener("keydown", onKeyDown as any);
    }, [showPaymentModal]);

    const cashOk = selectedPayment !== "cash" || (parseFloat(cashReceived || "0") >= total);

    const executePayment = async () => {
  if (cart.length === 0) return;
  if (!cashOk) return;

  const method = selectedPayment || "cash";

  setShowPaymentModal(false);
  setShowSuccessModal(true);

  // ✅ Parent (POSPage) must handle: save sale + print + clear cart
  try {
    await Promise.resolve(onComplete?.(method));
  } finally {
    // keep short success animation then reset local UI
    setTimeout(() => {
      setShowSuccessModal(false);
      setCashReceived("");
      setSelectedPayment("cash");
    }, 600);
  }
};

    const change = selectedPayment === "cash" && cashReceived ? parseFloat(cashReceived) - total : 0;

    return (
      <>
        <div className="border-t border-border p-4 space-y-4 bg-card">
          <div className="space-y-2">
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Subtotal</span>
              <span>${subtotal.toFixed(2)}</span>
            </div>

            {discount > 0 && (
              <div className="flex justify-between text-sm text-success">
                <span>Discount</span>
                <span>-${discount.toFixed(2)}</span>
              </div>
            )}

            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Tax</span>
              <span>${tax.toFixed(2)}</span>
            </div>

            <div className="flex justify-between text-lg font-bold pt-2 border-t border-border">
              <span>Total</span>
              <span className="text-primary">${total.toFixed(2)}</span>
            </div>
          </div>

          {/* Payment method quick select */}
          <div className="grid grid-cols-4 gap-2">
            {paymentMethods.map((method) => (
              <button
                key={method.id}
                onClick={() => setSelectedPayment(method.id)}
                className={cn(
                  "flex flex-col items-center gap-1 p-3 rounded-xl border-2 transition-all relative",
                  selectedPayment === method.id
                    ? method.color
                    : "border-border bg-muted/30 text-muted-foreground hover:border-primary/30"
                )}
              >
                <kbd className="absolute top-1 right-1 text-[9px] font-mono opacity-50">{method.shortcut}</kbd>
                <method.icon className="w-5 h-5" />
                <span className="text-xs font-medium">{method.label}</span>
              </button>
            ))}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Button
              variant="outline"
              onClick={holdCurrentSale}
              disabled={cart.length === 0}
              className="gap-2"
            >
              <Pause className="w-4 h-4" /> Hold{" "}
              <kbd className="ml-auto text-[10px] font-mono opacity-50 bg-muted px-1 rounded">F3</kbd>
            </Button>

            <Button
              onClick={() => {
                if (cart.length === 0) return;
                setShowPaymentModal(true);
              }}
              disabled={cart.length === 0}
              className="gap-2 bg-primary hover:bg-primary-hover text-primary-foreground"
            >
              <Receipt className="w-4 h-4" /> Pay{" "}
              <kbd className="ml-auto text-[10px] font-mono opacity-50 bg-primary-foreground/20 px-1 rounded">
                F12
              </kbd>
            </Button>
          </div>
        </div>

        {/* Payment modal */}
        <AnimatePresence>
          {showPaymentModal && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4"
              onClick={closePayment}
            >
              <motion.div
                initial={{ scale: 0.95 }}
                animate={{ scale: 1 }}
                exit={{ scale: 0.95 }}
                className="bg-card rounded-2xl p-6 w-full max-w-md shadow-xl"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="flex items-center justify-between mb-6">
                  <h3 className="text-xl font-bold">Complete Payment</h3>
                  <Button variant="ghost" size="icon" onClick={closePayment}>
                    <X className="w-5 h-5" />
                  </Button>
                </div>

                <div className="space-y-6">
                  <div className="text-center py-6 bg-muted/30 rounded-xl">
                    <p className="text-sm text-muted-foreground mb-1">Amount Due</p>
                    <p className="text-4xl font-bold text-primary">${total.toFixed(2)}</p>
                  </div>

                  {selectedPayment === "cash" && (
                    <div className="space-y-4">
                      <div>
                        <label className="text-sm font-medium mb-2 block">Cash Received</label>
                        <Input
                          type="number"
                          placeholder="Enter amount..."
                          value={cashReceived}
                          onChange={(e) => setCashReceived(e.target.value)}
                          className="h-12 text-lg font-mono"
                          autoFocus
                          onKeyDown={(e) => {
                            if (e.key === "Enter" && cashOk) executePayment();
                          }}
                        />
                      </div>

                      {parseFloat(cashReceived || "0") >= total && (
                        <div className="p-4 bg-green-500/10 rounded-xl text-center">
                          <p className="text-sm text-green-500 mb-1">Change Due</p>
                          <p className="text-2xl font-bold text-green-500">${change.toFixed(2)}</p>
                        </div>
                      )}

                      <div className="grid grid-cols-4 gap-2">
                        {[10, 20, 50, 100].map((amount) => (
                          <Button
                            key={amount}
                            variant="outline"
                            onClick={() => setCashReceived(amount.toString())}
                            className="font-mono"
                          >
                            ${amount}
                          </Button>
                        ))}
                      </div>
                    </div>
                  )}

                  <Button
                    onClick={executePayment}
                    disabled={!cashOk}
                    className="w-full h-12 text-lg font-semibold gap-2"
                  >
                    Complete & Print{" "}
                    <kbd className="text-xs font-mono opacity-70 bg-primary-foreground/20 px-1.5 py-0.5 rounded">
                      Enter
                    </kbd>
                  </Button>

                  <p className="text-[11px] text-muted-foreground text-center">
                    Press <kbd className="bg-muted px-1 rounded">Esc</kbd> to cancel
                  </p>
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Success modal */}
        <AnimatePresence>
          {showSuccessModal && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center"
            >
              <motion.div
                initial={{ scale: 0.5 }}
                animate={{ scale: 1 }}
                exit={{ scale: 0.5 }}
                className="bg-card rounded-2xl p-8 text-center shadow-xl"
              >
                <motion.div
                  initial={{ scale: 0 }}
                  animate={{ scale: 1 }}
                  className="w-20 h-20 rounded-full bg-green-500/10 flex items-center justify-center mx-auto mb-4"
                >
                  <CheckCircle2 className="w-10 h-10 text-green-500" />
                </motion.div>
                <h3 className="text-xl font-bold mb-2">Payment Successful!</h3>
                <p className="text-muted-foreground">Printing receipt...</p>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>
      </>
    );
  }
);

PaymentPanel.displayName = "PaymentPanel";
