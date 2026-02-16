// BinanceXI wordmark + mark (no image assets)
import { useMemo } from "react";
import { BRAND } from "@/lib/brand";
import { cn } from "@/lib/utils";

export function BrandMark({ className, title }: { className?: string; title?: string }) {
  const letter = useMemo(() => {
    const src = String(BRAND.shortName || BRAND.name || "B").trim();
    return (src ? src.slice(0, 1) : "B").toUpperCase();
  }, []);

  return (
    <div
      className={cn(
        "rounded-xl bg-primary/15 border border-primary/25 text-primary font-black select-none",
        "flex items-center justify-center leading-none",
        className
      )}
      title={title || BRAND.name}
      aria-label={BRAND.name}
    >
      <span className="relative">
        {letter}
        <span className="absolute -right-2 bottom-0.5 h-1.5 w-1.5 rounded-full bg-accent" aria-hidden="true" />
      </span>
    </div>
  );
}

type BrandLogoTone = "auto" | "dark" | "light";

export function BrandLogo({
  className,
  alt,
  title,
  tone = "auto",
}: {
  className?: string;
  alt?: string;
  title?: string;
  tone?: BrandLogoTone;
}) {
  const safeAlt = useMemo(() => {
    const a = String(alt || "").trim();
    return a || BRAND.name;
  }, [alt]);

  const short = String(BRAND.shortName || BRAND.name || "BinanceXI").trim();
  const base = useMemo(() => {
    if (!short) return "Binance";
    if (short.length > 2 && short.toUpperCase().endsWith("XI")) return short.slice(0, -2);
    return short;
  }, [short]);
  const suffix = useMemo(() => {
    if (!short) return "XI";
    if (short.length > 2 && short.toUpperCase().endsWith("XI")) return short.slice(-2);
    return "";
  }, [short]);

  const toneClasses = useMemo(() => {
    if (tone === "light") {
      return {
        baseText: "text-white",
        suffixText: "text-[#89dbff]",
        badge: "border-white/20 bg-white/10 text-white",
      };
    }
    if (tone === "dark") {
      return {
        baseText: "text-slate-950",
        suffixText: "text-primary",
        badge: "border-slate-950/20 bg-slate-950/5 text-slate-950",
      };
    }
    return {
      baseText: "text-foreground",
      suffixText: "bg-gradient-to-r from-primary to-accent bg-clip-text text-transparent",
      badge: "border-primary/30 bg-primary/15 text-primary",
    };
  }, [tone]);

  return (
    <div
      className={cn(
        "inline-flex items-center justify-center gap-2 select-none whitespace-nowrap leading-none",
        "font-extrabold tracking-tight",
        "text-[clamp(28px,4.6vw,60px)]",
        className
      )}
      aria-label={safeAlt}
      title={title || BRAND.name}
    >
      <span className={cn("flex items-baseline", toneClasses.baseText)}>
        <span>{base}</span>
        {suffix ? <span className={cn("ml-[1px]", toneClasses.suffixText)}>{suffix}</span> : null}
      </span>
      <span
        className={cn(
          "rounded-md px-2 py-1 text-[0.32em] font-black tracking-[0.28em] uppercase border",
          toneClasses.badge
        )}
      >
        POS
      </span>
    </div>
  );
}
