import { Capacitor } from "@capacitor/core";
import type { ThermalJob } from "@/lib/printQueue";
import { getThermalQueue, removeThermalJob } from "@/lib/printQueue";
import { printToBluetooth58mm } from "@/lib/androidBluetoothPrint";
import { buildReceiptPrintModel, type ReceiptStoreSettings } from "@/core/receipts/receiptPrintModel";

// settings keys (used by your Settings UI)
export const PRINTER_MODE_KEY = "binancexi_printer_mode"; // "browser" | "tcp" | "bt"
export const PRINTER_IP_KEY = "binancexi_printer_ip"; // e.g. 192.168.1.50
export const PRINTER_PORT_KEY = "binancexi_printer_port"; // usually 9100
export const PRINTER_TRANSPORT_KEY = "binancexi_printer_transport"; // "tcp" | "serial" | "spooler" | "browser" | "bt"
export const PRINTER_SERIAL_PORT_KEY = "binancexi_printer_serial_port"; // e.g. COM5
export const PRINTER_SERIAL_BAUD_KEY = "binancexi_printer_serial_baud"; // e.g. 9600
export const PRINTER_SPOOLER_PRINTER_KEY = "binancexi_printer_spooler_name"; // Windows printer name
export const PRINTER_AUTO_PRINT_SALES_KEY = "binancexi_printer_auto_print_sales"; // "1" | "0"
export const PRINTER_FALLBACK_BROWSER_KEY = "binancexi_printer_fallback_browser"; // "1" | "0"

type PrinterTransport = "browser" | "tcp" | "bt" | "serial" | "spooler";

export type PrinterOverrides = {
  transport?: PrinterTransport;
  tcp_host?: string;
  tcp_port?: number;
  serial_port?: string;
  serial_baud?: number;
  spooler_printer_name?: string;
  fallback_to_browser?: boolean;
};

type PrinterConfig = {
  transport: PrinterTransport;
  tcp_host: string;
  tcp_port: number;
  serial_port: string;
  serial_baud: number;
  spooler_printer_name: string;
  fallback_to_browser: boolean;
};

const encoder = new TextEncoder();
const ESC = 0x1b;
const GS = 0x1d;

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

function isTauriRuntime() {
  if (typeof window === "undefined") return false;
  const w = window as any;
  const ua = String(window.navigator?.userAgent || "");
  return Boolean(
    w.__TAURI_INTERNALS__ ||
      w.__TAURI__ ||
      w.__TAURI_IPC__ ||
      ua.includes("Tauri")
  );
}

function normalizePrinterMode(rawMode: string, platform: string, tauriRuntime = false): PrinterTransport {
  const mode = String(rawMode || "").trim().toLowerCase();
  if (platform === "android") {
    if (mode === "tcp" || mode === "bt") return mode;
    return "bt";
  }
  // desktop/web
  if (mode === "browser" || mode === "tcp" || mode === "serial" || mode === "spooler") return mode;
  if (mode === "bt" && tauriRuntime) return "bt";
  return "browser";
}

function loadPrinterConfig(platform: string, tauriRuntime: boolean, overrides?: PrinterOverrides): PrinterConfig {
  const legacyMode = String(localStorage.getItem(PRINTER_MODE_KEY) || "").trim();
  const transportRaw = String(localStorage.getItem(PRINTER_TRANSPORT_KEY) || legacyMode || "").trim();
  const transport = normalizePrinterMode(transportRaw || (platform === "android" ? "bt" : "browser"), platform, tauriRuntime);
  const tcp_host = String(localStorage.getItem(PRINTER_IP_KEY) || "").trim();
  const tcp_port = Number(localStorage.getItem(PRINTER_PORT_KEY) || "9100");
  const serial_port = String(localStorage.getItem(PRINTER_SERIAL_PORT_KEY) || "").trim();
  const serial_baud = Number(localStorage.getItem(PRINTER_SERIAL_BAUD_KEY) || "9600");
  const spooler_printer_name = String(localStorage.getItem(PRINTER_SPOOLER_PRINTER_KEY) || "").trim();
  const fallbackToBrowserRaw = localStorage.getItem(PRINTER_FALLBACK_BROWSER_KEY);
  const fallback_to_browser =
    fallbackToBrowserRaw == null ? true : ["1", "true", "yes"].includes(String(fallbackToBrowserRaw).toLowerCase());

  return {
    transport: overrides?.transport || transport,
    tcp_host: String(overrides?.tcp_host ?? tcp_host).trim(),
    tcp_port: Number(overrides?.tcp_port ?? tcp_port ?? 9100),
    serial_port: String(overrides?.serial_port ?? serial_port).trim(),
    serial_baud: Number(overrides?.serial_baud ?? serial_baud ?? 9600),
    spooler_printer_name: String(overrides?.spooler_printer_name ?? spooler_printer_name).trim(),
    fallback_to_browser:
      typeof overrides?.fallback_to_browser === "boolean" ? overrides.fallback_to_browser : fallback_to_browser,
  };
}

export function isAutoPrintSalesEnabled() {
  const raw = localStorage.getItem(PRINTER_AUTO_PRINT_SALES_KEY);
  if (raw == null) return true;
  return ["1", "true", "yes"].includes(String(raw).trim().toLowerCase());
}

function leftRight(left: string, right: string, width = 32) {
  const space = Math.max(1, width - left.length - right.length);
  return left + " ".repeat(space) + right;
}

function money(n: number) {
  return n.toFixed(2);
}

function bytes(...arr: number[]) {
  return new Uint8Array(arr);
}
function textLine(s: string) {
  return encoder.encode(s + "\n");
}
function concat(parts: Uint8Array[]) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function esc(s: string) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export type ThermalReceiptData = {
  receiptId?: string;
  receiptNumber: string;
  timestamp: string;
  cashierName: string;
  customerName?: string;
  paymentMethod: string;
  cart: Array<{ product: { name: string; price: number }; quantity: number; customPrice?: number }>;
  subtotal: number;
  discount: number;
  tax: number;
  total: number;
  activeDiscountName?: string | null;
  taxRatePct?: number | null;
  settings?: ReceiptStoreSettings | null;
};

function buildCanonicalReceiptModel(d: ThermalReceiptData) {
  return buildReceiptPrintModel({
    cart: (d.cart || []) as any,
    cashierName: d.cashierName || "Staff",
    customerName: d.customerName || "",
    receiptId: d.receiptId || d.receiptNumber,
    receiptNumber: d.receiptNumber,
    paymentMethod: d.paymentMethod || "cash",
    subtotal: Number(d.subtotal || 0),
    discount: Number(d.discount || 0),
    tax: Number(d.tax || 0),
    total: Number(d.total || 0),
    activeDiscount: d.activeDiscountName ? ({ name: d.activeDiscountName } as any) : null,
    taxRatePct: d.taxRatePct ?? null,
    timestamp: d.timestamp || new Date().toISOString(),
    settings: d.settings || {},
  });
}

function buildFallbackReceiptHtml(d: ThermalReceiptData) {
  const model = buildCanonicalReceiptModel(d);
  const items = (model.items || [])
    .map((it) => {
      const name = esc(String(it.name || "Item"));
      return `
        <div style="margin-bottom:6px;">
          <div style="font-weight:700;">${name}</div>
          <div style="display:flex;justify-content:space-between;">
            <span>${it.qty} x ${money(it.unit)}</span>
            <span>${money(it.lineTotal)}</span>
          </div>
          ${
            it.lineDiscount > 0
              ? `<div style="display:flex;justify-content:space-between;font-size:10px;">
                  <span>Disc</span>
                  <span>-${money(it.lineDiscount)}</span>
                </div>
                <div style="display:flex;justify-content:space-between;font-size:10px;font-weight:700;">
                  <span>Line Total</span>
                  <span>${money(it.finalLine)}</span>
                </div>`
              : ""
          }
          ${it.customDescription ? `<div style="font-size:10px;font-style:italic;">- ${esc(it.customDescription)}</div>` : ""}
        </div>
      `;
    })
    .join("");

  return `
    <div style="width:58mm;padding:6px;font-family:monospace;font-size:11px;line-height:1.3;color:#000;background:#fff;">
      ${
        model.header.logoUrl
          ? `<div style="text-align:center;margin-bottom:4px;"><img src="${esc(model.header.logoUrl)}" alt="${esc(model.header.logoAlt)}" style="max-width:${Number(model.header.logoMaxWidthPx || 148)}px;max-height:${Number(model.header.logoMaxHeightPx || 34)}px;width:auto;height:auto;" /></div>`
          : ""
      }
      <div style="text-align:center;font-weight:800;font-size:11px;letter-spacing:1px;">${model.header.brandTitleLines
        .map((line) => esc(line))
        .join("<br/>")}</div>
      ${model.header.brandSupportLine ? `<div style="text-align:center;font-size:9px;margin-top:2px;">${esc(model.header.brandSupportLine)}</div>` : ""}
      <div style="text-align:center;font-weight:800;font-size:16px;margin-top:4px;">${esc(model.header.businessName)}</div>
      ${model.header.address ? `<div style="text-align:center;">${esc(model.header.address)}</div>` : ""}
      ${model.header.phone ? `<div style="text-align:center;">${esc(model.header.phone)}</div>` : ""}
      ${model.header.taxId ? `<div style="text-align:center;font-weight:700;">TAX: ${esc(model.header.taxId)}</div>` : ""}
      <div style="border-top:1px dashed #000;margin:6px 0;"></div>
      <div style="display:flex;justify-content:space-between;font-size:10px;">
        <div>
          <div>${esc(model.meta.dateLabel)}</div>
          <div>${esc(model.meta.timeLabel)}</div>
        </div>
        <div style="text-align:right;">
          <div style="font-weight:700;">#${esc(model.meta.receiptNumber)}</div>
          <div>Staff: ${esc(model.meta.cashierName)}</div>
        </div>
      </div>
      <div style="text-align:center;border:1px solid #000;padding:4px;margin-top:6px;margin-bottom:6px;font-weight:700;">Customer: ${esc(model.meta.customerName)}</div>
      <div style="border-top:1px dashed #000;margin:6px 0;"></div>
      ${items || "<div>No items</div>"}
      <div style="border-top:1px dashed #000;margin:6px 0;"></div>
      <div style="display:flex;justify-content:space-between;"><span>Subtotal</span><span>${money(model.totals.subtotal)}</span></div>
      ${
        model.totals.showGlobalDiscount
          ? `<div style="display:flex;justify-content:space-between;"><span>Discount${
              model.totals.activeDiscountName ? ` (${esc(model.totals.activeDiscountName)})` : ""
            }</span><span>-${money(model.totals.discount)}</span></div>`
          : ""
      }
      ${
        model.totals.showTax
          ? `<div style="display:flex;justify-content:space-between;"><span>Tax${
              typeof model.totals.taxRatePct === "number" ? ` (${esc(String(model.totals.taxRatePct))}%)` : ""
            }</span><span>${money(model.totals.tax)}</span></div>`
          : ""
      }
      <div style="display:flex;justify-content:space-between;font-weight:800;font-size:13px;margin-top:4px;">
        <span>TOTAL</span><span>${money(model.totals.total)}</span>
      </div>
      <div style="text-align:center;margin-top:8px;">Paid via ${esc(model.meta.paymentMethod)}</div>
      ${
        model.verification.showQrCode
          ? `<div style="text-align:center;margin-top:8px;font-size:10px;">Scan to Verify</div><div style="text-align:center;font-size:9px;word-break:break-all;">ID: ${esc(model.meta.receiptId)}</div><div style="text-align:center;font-size:9px;word-break:break-all;">${esc(model.verification.payload)}</div>`
          : ""
      }
      ${model.footer.footerMessage ? `<div style="text-align:center;margin-top:8px;white-space:pre-wrap;text-transform:uppercase;">${esc(model.footer.footerMessage)}</div>` : ""}
      <div style="text-align:center;margin-top:8px;font-size:9px;font-weight:700;">${esc(model.footer.poweredByLine)}</div>
    </div>
  `;
}

function collectHeadStyles() {
  try {
    const nodes = Array.from(
      document.querySelectorAll('style,link[rel="stylesheet"]')
    ) as Array<HTMLStyleElement | HTMLLinkElement>;
    return nodes.map((n) => n.outerHTML).join("\n");
  } catch {
    return "";
  }
}

async function printHtmlInIframe(receiptHtml: string) {
  const iframe = document.createElement("iframe");
  iframe.setAttribute("aria-hidden", "true");
  iframe.style.position = "fixed";
  iframe.style.right = "0";
  iframe.style.bottom = "0";
  iframe.style.width = "1px";
  iframe.style.height = "1px";
  iframe.style.opacity = "0";
  iframe.style.pointerEvents = "none";
  iframe.style.border = "0";
  document.body.appendChild(iframe);

  try {
    const doc = iframe.contentDocument || iframe.contentWindow?.document;
    if (!doc) throw new Error("Unable to initialize print frame");

    const sharedStyles = collectHeadStyles();
    doc.open();
    doc.write(`
      <!doctype html>
      <html>
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          ${sharedStyles}
          <style>
            @page { size: 58mm auto; margin: 0; }
            html, body {
              margin: 0 !important;
              padding: 0 !important;
              width: 58mm !important;
              background: #fff !important;
              color: #000 !important;
            }
            #receipt-print-area {
              width: 58mm !important;
              margin: 0 !important;
              padding: 0 !important;
            }
          </style>
        </head>
        <body>
          <div id="receipt-print-area">${receiptHtml}</div>
        </body>
      </html>
    `);
    doc.close();

    await new Promise<void>((resolve) => {
      if (doc.readyState === "complete") resolve();
      else iframe.onload = () => resolve();
    });

    const images = Array.from(doc.images || []);
    await Promise.race([
      Promise.all(
        images.map(async (img) => {
          if ((img as HTMLImageElement).complete) return;
          await new Promise<void>((resolve) => {
            img.addEventListener("load", () => resolve(), { once: true });
            img.addEventListener("error", () => resolve(), { once: true });
          });
        })
      ),
      sleep(2500),
    ]);

    const win = iframe.contentWindow;
    if (!win) throw new Error("Print frame window missing");

    await new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve();
      };
      const t = setTimeout(finish, 3000);
      win.addEventListener(
        "afterprint",
        () => {
          clearTimeout(t);
          finish();
        },
        { once: true }
      );
      win.focus();
      win.print();
    });
  } finally {
    iframe.remove();
  }
}

function splitPrinterText(text: string, width = 32) {
  const raw = String(text || "").trim();
  if (!raw) return [""];
  const words = raw.split(/\s+/);
  const lines: string[] = [];
  let line = "";

  for (const word of words) {
    if (!line) {
      if (word.length <= width) {
        line = word;
        continue;
      }
      for (let i = 0; i < word.length; i += width) lines.push(word.slice(i, i + width));
      line = "";
      continue;
    }
    if ((line + " " + word).length <= width) {
      line += " " + word;
      continue;
    }
    lines.push(line);
    if (word.length <= width) {
      line = word;
    } else {
      for (let i = 0; i < word.length; i += width) lines.push(word.slice(i, i + width));
      line = "";
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [raw.slice(0, width)];
}

function escPosQr(payload: string) {
  const data = encoder.encode(String(payload || ""));
  const storeLen = data.length + 3;
  const pL = storeLen & 0xff;
  const pH = (storeLen >> 8) & 0xff;

  return concat([
    bytes(GS, 0x28, 0x6b, 0x04, 0x00, 0x31, 0x41, 0x32, 0x00), // model 2
    bytes(GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x43, 0x05), // module size
    bytes(GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x45, 0x31), // error correction M
    bytes(GS, 0x28, 0x6b, pL, pH, 0x31, 0x50, 0x30), // store
    data,
    bytes(GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x51, 0x30), // print
  ]);
}

async function loadImageForRaster(src: string): Promise<HTMLImageElement> {
  return await new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = "async";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Logo image failed to load"));
    img.src = src;
  });
}

async function escPosRasterImage(src: string, opts?: { maxWidth?: number; maxHeight?: number }) {
  if (typeof document === "undefined") return null;
  const maxWidth = Math.max(64, Math.min(384, Math.trunc(opts?.maxWidth ?? 224)));
  const maxHeight = Math.max(16, Math.min(128, Math.trunc(opts?.maxHeight ?? 56)));

  try {
    const img = await loadImageForRaster(src);
    const naturalW = Math.max(1, img.naturalWidth || img.width || maxWidth);
    const naturalH = Math.max(1, img.naturalHeight || img.height || maxHeight);
    const scale = Math.min(maxWidth / naturalW, maxHeight / naturalH);
    let width = Math.max(8, Math.round(naturalW * scale));
    let height = Math.max(8, Math.round(naturalH * scale));
    width = Math.min(maxWidth, Math.ceil(width / 8) * 8);
    height = Math.min(maxHeight, height);

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;

    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, width, height);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(img, 0, 0, width, height);
    const imageData = ctx.getImageData(0, 0, width, height);
    const data = imageData.data;
    const xBytes = width / 8;
    const raster = new Uint8Array(xBytes * height);

    for (let y = 0; y < height; y++) {
      for (let xByte = 0; xByte < xBytes; xByte++) {
        let byteVal = 0;
        for (let bit = 0; bit < 8; bit++) {
          const x = xByte * 8 + bit;
          const idx = (y * width + x) * 4;
          const r = data[idx] ?? 255;
          const g = data[idx + 1] ?? 255;
          const b = data[idx + 2] ?? 255;
          const a = data[idx + 3] ?? 255;
          const luminance = (r * 0.299 + g * 0.587 + b * 0.114) * (a / 255) + 255 * (1 - a / 255);
          if (luminance < 180) byteVal |= 1 << (7 - bit);
        }
        raster[y * xBytes + xByte] = byteVal;
      }
    }

    const xL = xBytes & 0xff;
    const xH = (xBytes >> 8) & 0xff;
    const yL = height & 0xff;
    const yH = (height >> 8) & 0xff;
    return concat([bytes(GS, 0x76, 0x30, 0x00, xL, xH, yL, yH), raster]);
  } catch (err) {
    console.warn("[print] receipt logo raster skipped:", err);
    return null;
  }
}

async function buildEscPos(d: ThermalReceiptData) {
  const model = buildCanonicalReceiptModel(d);
  const parts: Uint8Array[] = [];
  const divider = "-".repeat(32);

  parts.push(bytes(ESC, 0x40)); // init
  parts.push(bytes(ESC, 0x61, 0x01)); // center

  if (model.header.logoUrl) {
    const rasterLogo = await escPosRasterImage(model.header.logoUrl, {
      maxWidth: 224,
      maxHeight: Math.max(32, Number(model.header.logoMaxHeightPx || 40) * 2),
    });
    if (rasterLogo) {
      parts.push(rasterLogo);
      parts.push(textLine(""));
    }
  }

  parts.push(bytes(ESC, 0x45, 0x01)); // bold on
  for (const line of model.header.brandTitleLines) {
    if (!line) continue;
    parts.push(textLine(line));
  }
  parts.push(bytes(ESC, 0x45, 0x00)); // bold off
  if (model.header.brandSupportLine) parts.push(textLine(model.header.brandSupportLine));
  parts.push(textLine(model.header.businessName));
  if (model.header.address) {
    for (const line of splitPrinterText(model.header.address, 32)) parts.push(textLine(line));
  }
  if (model.header.phone) parts.push(textLine(model.header.phone));
  if (model.header.taxId) parts.push(textLine(`TAX: ${model.header.taxId}`));

  parts.push(textLine(divider));
  parts.push(bytes(ESC, 0x61, 0x00)); // left align
  parts.push(textLine(model.meta.dateLabel));
  parts.push(textLine(model.meta.timeLabel));
  parts.push(textLine(leftRight(`#${model.meta.receiptNumber}`, `Staff:${model.meta.cashierName.slice(0, 10)}`)));
  parts.push(textLine(`Customer: ${model.meta.customerName}`));
  parts.push(textLine(divider));

  for (const it of model.items) {
    for (const line of splitPrinterText(it.name, 32)) parts.push(textLine(line));
    parts.push(textLine(leftRight(`${it.qty} x ${money(it.unit)}`, money(it.lineTotal))));
    if (it.lineDiscount > 0) {
      parts.push(textLine(leftRight("Disc", `-${money(it.lineDiscount)}`)));
      parts.push(textLine(leftRight("Line Total", money(it.finalLine))));
    }
    if (it.customDescription) {
      for (const line of splitPrinterText(`- ${it.customDescription}`, 32)) parts.push(textLine(line));
    }
  }

  parts.push(textLine(divider));
  parts.push(textLine(leftRight("Subtotal", money(model.totals.subtotal))));
  if (model.totals.showGlobalDiscount) {
    const label = model.totals.activeDiscountName ? `Discount (${model.totals.activeDiscountName})` : "Discount";
    parts.push(textLine(leftRight(label.slice(0, 18), `-${money(model.totals.discount)}`)));
  }
  if (model.totals.showTax) {
    const taxLabel =
      typeof model.totals.taxRatePct === "number" ? `Tax (${model.totals.taxRatePct}%)` : "Tax";
    parts.push(textLine(leftRight(taxLabel, money(model.totals.tax))));
  }

  parts.push(bytes(ESC, 0x45, 0x01)); // bold
  parts.push(textLine(leftRight("TOTAL", money(model.totals.total))));
  parts.push(bytes(ESC, 0x45, 0x00));
  parts.push(textLine(divider));
  parts.push(bytes(ESC, 0x61, 0x01)); // center
  parts.push(textLine(`Paid via ${String(model.meta.paymentMethod || "").toUpperCase()}`));

  if (model.verification.showQrCode && model.verification.payload) {
    try {
      parts.push(textLine(""));
      parts.push(escPosQr(model.verification.payload));
      parts.push(textLine("Scan to Verify"));
    } catch (err) {
      console.warn("[print] qr command generation failed:", err);
    }
    parts.push(textLine(`ID: ${model.meta.receiptId}`));
  }

  if (model.footer.footerMessage) {
    for (const line of splitPrinterText(model.footer.footerMessage.toUpperCase(), 32)) {
      parts.push(textLine(line));
    }
  }
  parts.push(textLine(model.footer.poweredByLine));
  parts.push(bytes(ESC, 0x61, 0x00));

  // Feed extra lines so the tear/cut doesn't eat the last line.
  parts.push(bytes(ESC, 0x64, 0x05));
  parts.push(bytes(GS, 0x56, 0x00)); // cut (some printers ignore; safe)

  return concat(parts);
}

async function printBrowserReceipt(d?: ThermalReceiptData) {
  // We rely on an existing DOM node with this id (POSPage + ReceiptsPage include it).
  let el = document.getElementById("receipt-print-area") as HTMLElement | null;
  let createdHost = false;
  if (!el) {
    el = document.createElement("div");
    el.id = "receipt-print-area";
    document.body.appendChild(el);
    createdHost = true;
  }

  // Temporarily force it to render (even if Tailwind's `hidden` is applied).
  const prevStyle = el.getAttribute("style");
  let fallbackNode: HTMLElement | null = null;
  el.style.display = "block";
  el.style.position = "fixed";
  el.style.left = "-9999px";
  el.style.top = "0";
  el.style.width = "58mm";
  el.style.overflow = "visible";

  try {
    // Give React/layout time to flush.
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
    await new Promise<void>((r) => requestAnimationFrame(() => r()));

    // Wait for printable content to be mounted to avoid blank print pages.
    const waitStart = Date.now();
    while (Date.now() - waitStart < 3000) {
      const hasNodes = el.children.length > 0;
      const hasText = (el.textContent || "").trim().length > 0;
      if (hasNodes || hasText) break;
      if (!fallbackNode && d) {
        fallbackNode = document.createElement("div");
        fallbackNode.setAttribute("data-print-fallback", "1");
        fallbackNode.innerHTML = buildFallbackReceiptHtml(d);
        el.appendChild(fallbackNode);
      }
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
    }

    const hasRenderableContent = el.children.length > 0 || (el.textContent || "").trim().length > 0;
    if (!hasRenderableContent && d) {
      fallbackNode = document.createElement("div");
      fallbackNode.setAttribute("data-print-fallback", "1");
      fallbackNode.innerHTML = buildFallbackReceiptHtml(d);
      el.appendChild(fallbackNode);
    }

    // Wait for web fonts (prevents reflow mid-print).
    const anyDoc = document as any;
    if (anyDoc.fonts?.ready) {
      await Promise.race([anyDoc.fonts.ready, sleep(2000)]);
    }

    // Wait for images (logo) to decode/load.
    const imgs = Array.from(el.querySelectorAll("img")) as HTMLImageElement[];
    await Promise.race([
      Promise.all(
        imgs.map(async (img) => {
          if (img.complete) return;
          try {
            if (typeof (img as any).decode === "function") {
              await (img as any).decode();
              return;
            }
          } catch {
            // fallback to events below
          }
          await new Promise<void>((resolve) => {
            const done = () => resolve();
            img.addEventListener("load", done, { once: true });
            img.addEventListener("error", done, { once: true });
          });
        })
      ),
      sleep(2500),
    ]);

    await new Promise<void>((r) => requestAnimationFrame(() => r()));

    const htmlToPrint = (el.innerHTML || "").trim();
    if (!htmlToPrint) throw new Error("Receipt content is empty");
    await printHtmlInIframe(htmlToPrint);
  } finally {
    if (fallbackNode && fallbackNode.parentElement === el) {
      fallbackNode.remove();
    }
    if (prevStyle == null) el.removeAttribute("style");
    else el.setAttribute("style", prevStyle);
    if (createdHost) {
      el.remove();
    }
  }
}

async function sendTcp(ip: string, port: number, data: Uint8Array) {
  // Only supported if you actually have a TcpSocket plugin installed
  if (Capacitor.getPlatform() !== "android") {
    throw new Error("TCP printing only supported on Android");
  }

  const TcpSocket = (window as any)?.Capacitor?.Plugins?.TcpSocket;
  if (!TcpSocket) throw new Error("TCP plugin not available");

  const socketId = await TcpSocket.connect({ host: ip, port });

  const bin = Array.from(data).map((b) => String.fromCharCode(b)).join("");
  const b64 = btoa(bin);

  await TcpSocket.write({ socketId, data: b64, encoding: "base64" });
  await TcpSocket.close({ socketId });
}

async function sendTcpDesktopViaTauri(ip: string, port: number, data: Uint8Array) {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("tcp_print_escpos", { host: ip, port, data: Array.from(data) });
  } catch (e: any) {
    throw new Error(e?.message || "Tauri TCP print failed");
  }
}

async function sendSerialDesktopViaTauri(port: string, baud: number, data: Uint8Array) {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("serial_print_escpos", { port, baud, data: Array.from(data) });
  } catch (e: any) {
    throw new Error(e?.message || "Tauri serial print failed");
  }
}

async function sendSpoolerDesktopViaTauri(printer_name: string, data: Uint8Array) {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("spooler_print_raw", { printer_name, data: Array.from(data) });
  } catch (e: any) {
    throw new Error(e?.message || "Tauri spooler print failed");
  }
}

export type SerialPortInfo = {
  port_name: string;
  port_type: string;
  manufacturer?: string | null;
  product?: string | null;
  serial_number?: string | null;
  vid?: number | null;
  pid?: number | null;
};

export async function listSerialPorts(): Promise<SerialPortInfo[]> {
  if (!isTauriRuntime()) return [];
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const rows = await invoke<SerialPortInfo[]>("list_serial_ports");
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

export async function listWindowsPrinters(): Promise<string[]> {
  if (!isTauriRuntime()) return [];
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const rows = await invoke<string[]>("list_windows_printers");
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

export async function printReceiptSmart(d: ThermalReceiptData, overrides?: PrinterOverrides) {
  const platform = Capacitor.getPlatform();
  const tauriRuntime = isTauriRuntime();
  const printer = loadPrinterConfig(platform, tauriRuntime, overrides);
  const model = buildCanonicalReceiptModel(d);
  const debugEnabled =
    !!(import.meta as any)?.env?.DEV || localStorage.getItem("binancexi_debug_receipt_qr") === "1";
  if (debugEnabled) {
    console.info("[receipt-print] canonical payload", {
      receiptId: model.meta.receiptId,
      receiptNumber: model.meta.receiptNumber,
      verificationPayload: model.verification.payload,
      printer,
    });
  }

  const escpos = await buildEscPos(d);

  // ✅ ANDROID
  if (platform === "android") {
    if (printer.transport === "bt") {
      await printToBluetooth58mm(escpos, { chunkSize: 800, chunkDelayMs: 35, retries: 3 });
      return;
    }

    // Android supports BT + TCP in this app.
    const ip = printer.tcp_host;
    const port = printer.tcp_port;
    if (!ip) {
      if (printer.fallback_to_browser === false) {
        throw new Error("Printer IP not set for Android TCP mode");
      }
      await printToBluetooth58mm(escpos, { chunkSize: 800, chunkDelayMs: 35, retries: 3 });
      return;
    }
    await sendTcp(ip, port, escpos);
    return;
  }

  if (tauriRuntime) {
    if (printer.transport === "tcp") {
      if (!printer.tcp_host) throw new Error("Printer IP not set for TCP transport");
      await sendTcpDesktopViaTauri(printer.tcp_host, printer.tcp_port, escpos);
      return;
    }
    if (printer.transport === "serial" || printer.transport === "bt") {
      if (!printer.serial_port) throw new Error("Serial/COM port not set");
      await sendSerialDesktopViaTauri(printer.serial_port, printer.serial_baud, escpos);
      return;
    }
    if (printer.transport === "spooler") {
      if (!printer.spooler_printer_name) throw new Error("Windows printer name not set");
      await sendSpoolerDesktopViaTauri(printer.spooler_printer_name, escpos);
      return;
    }
    if (printer.transport === "browser") {
      await printBrowserReceipt(d);
      return;
    }
  }

  // Browser runtime: explicit fallback only.
  if (printer.transport === "browser") {
    await printBrowserReceipt(d);
    return;
  }
  if (printer.fallback_to_browser) {
    await printBrowserReceipt(d);
    return;
  }
  throw new Error(`Transport '${printer.transport}' requires desktop runtime`);
}

// --------------------
// QUEUE PROCESSOR
// --------------------
let processing = false;

export async function tryPrintThermalQueue() {
  if (processing) return;
  processing = true;

  try {
    const q = getThermalQueue();
    if (!q.length) return;

    const job: ThermalJob = q[0];

    await printReceiptSmart(job as any);

    removeThermalJob(job.receiptNumber);
    } catch (err: any) {
    console.warn("Thermal print failed (kept queued):", err);

    // ✅ Show error on screen
    const { toast } = await import("sonner");
    toast.error(err?.message || "Printing failed");
  } finally {
    processing = false;
  }
}
