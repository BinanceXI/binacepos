import receiptLogoUrl from "@/assets/binancexi-receipt-logo.svg";

// BinanceXI POS (by Binance Labs)
export type BrandConfig = {
  name: string;
  shortName: string;
  receiptTitleLines: string[];
  supportLine?: string;
  receiptLogoUrl?: string;
  receiptLogoAlt?: string;
  receiptLogoMaxWidthPx?: number;
  receiptLogoMaxHeightPx?: number;
  colors: {
    primary: string;
    accent: string;
    accentMuted: string;
  };
};

export const BRAND: BrandConfig = {
  name: "BinanceXI POS",
  shortName: "BinanceXI",
  receiptTitleLines: ["BINANCEXI", "POS"],
  supportLine: "by Binance Labs",
  receiptLogoUrl,
  receiptLogoAlt: "BinanceXI POS",
  receiptLogoMaxWidthPx: 148,
  receiptLogoMaxHeightPx: 34,
  colors: {
    // Blue/cyan scheme.
    primary: "#197cbc",
    accent: "#2baee4",
    accentMuted: "#89dbff",
  },
};
