// BinanceXI POS (by Binance Labs)
export type BrandConfig = {
  name: string;
  shortName: string;
  receiptTitleLines: string[];
  supportLine?: string;
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
  colors: {
    // Blue/cyan scheme.
    primary: "#197cbc",
    accent: "#2baee4",
    accentMuted: "#89dbff",
  },
};
