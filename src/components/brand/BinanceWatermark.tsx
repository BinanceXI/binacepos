import { cn } from "@/lib/utils";

export function BinanceWatermark({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "pointer-events-none select-none font-extrabold uppercase tracking-[0.18em] text-[9px]",
        "text-primary/35 dark:text-accent/35",
        className
      )}
      aria-hidden="true"
    >
      Binance Labs
    </div>
  );
}
