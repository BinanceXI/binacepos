import { Capacitor } from "@capacitor/core";
import type { ThermalJob } from "@/lib/printQueue";
import { getThermalQueue, removeThermalJob } from "@/lib/printQueue";
import { printToBluetooth58mm } from "@/lib/androidBluetoothPrint";

// settings keys (used by your Settings UI)
export const PRINTER_MODE_KEY = "binancexi_printer_mode"; // "browser" | "tcp" | "bt"
export const PRINTER_IP_KEY = "binancexi_printer_ip"; // e.g. 192.168.1.50
export const PRINTER_PORT_KEY = "binancexi_printer_port"; // usually 9100

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

function normalizePrinterMode(rawMode: string, platform: string): "browser" | "tcp" | "bt" {
  const mode = String(rawMode || "").trim().toLowerCase();
  if (platform === "android") {
    if (mode === "tcp" || mode === "bt") return mode;
    return "bt";
  }
  // desktop/web
  if (mode === "browser" || mode === "tcp") return mode;
  return "browser";
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
};

function buildFallbackReceiptHtml(d: ThermalReceiptData) {
  const items = (d.cart || [])
    .map((it) => {
      const name = esc(String(it?.product?.name || "Item"));
      const qty = Number(it?.quantity || 0);
      const unit = Number(it?.customPrice ?? it?.product?.price ?? 0);
      const line = qty * unit;
      return `
        <div style="margin-bottom:6px;">
          <div style="font-weight:700;">${name}</div>
          <div style="display:flex;justify-content:space-between;">
            <span>${qty} x ${money(unit)}</span>
            <span>${money(line)}</span>
          </div>
        </div>
      `;
    })
    .join("");

  return `
    <div style="width:58mm;padding:6px;font-family:monospace;font-size:11px;line-height:1.3;color:#000;background:#fff;">
      <div style="text-align:center;font-weight:800;font-size:16px;">BINANCEXI POS</div>
      <div style="text-align:center;">Receipt: ${esc(d.receiptNumber)}</div>
      <div style="text-align:center;">${esc(d.timestamp)}</div>
      <div style="text-align:center;margin-bottom:6px;">Staff: ${esc(d.cashierName || "Staff")}</div>
      ${d.customerName ? `<div style="margin-bottom:6px;">Customer: ${esc(d.customerName)}</div>` : ""}
      <div style="border-top:1px dashed #000;margin:6px 0;"></div>
      ${items || "<div>No items</div>"}
      <div style="border-top:1px dashed #000;margin:6px 0;"></div>
      <div style="display:flex;justify-content:space-between;"><span>Subtotal</span><span>${money(d.subtotal)}</span></div>
      <div style="display:flex;justify-content:space-between;"><span>Discount</span><span>${money(d.discount)}</span></div>
      <div style="display:flex;justify-content:space-between;"><span>Tax</span><span>${money(d.tax)}</span></div>
      <div style="display:flex;justify-content:space-between;font-weight:800;font-size:13px;margin-top:4px;">
        <span>TOTAL</span><span>${money(d.total)}</span>
      </div>
      <div style="text-align:center;margin-top:8px;">Paid: ${esc(String(d.paymentMethod || "cash").toUpperCase())}</div>
      <div style="text-align:center;margin-top:8px;">Thank you!</div>
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

function buildEscPos(d: ThermalReceiptData) {
  const parts: Uint8Array[] = [];

  parts.push(bytes(ESC, 0x40)); // init
  parts.push(bytes(ESC, 0x61, 0x01)); // center
  parts.push(bytes(ESC, 0x45, 0x01)); // bold on
  parts.push(textLine("BINANCEXI POS"));
  parts.push(bytes(ESC, 0x45, 0x00)); // bold off
  parts.push(textLine(`Receipt: ${d.receiptNumber}`));
  parts.push(textLine(d.timestamp));
  parts.push(textLine(`Staff: ${d.cashierName}`));
  if (d.customerName?.trim()) parts.push(textLine(`Customer: ${d.customerName.trim()}`));
  parts.push(bytes(ESC, 0x61, 0x00)); // left

  parts.push(textLine("--------------------------------"));

  for (const it of d.cart) {
    const name = String(it.product?.name ?? "Item").slice(0, 20);
    const qty = Number(it.quantity || 0);
    const price = Number(it.customPrice ?? it.product?.price ?? 0);
    const total = qty * price;

    parts.push(textLine(name));
    parts.push(textLine(leftRight(`  ${qty} x ${money(price)}`, money(total))));
  }

  parts.push(textLine("--------------------------------"));
  parts.push(textLine(leftRight("Subtotal", money(d.subtotal))));
  if (d.discount > 0) parts.push(textLine(leftRight("Discount", `-${money(d.discount)}`)));
  if (d.tax > 0) parts.push(textLine(leftRight("Tax", money(d.tax))));

  parts.push(bytes(ESC, 0x45, 0x01)); // bold
  parts.push(textLine(leftRight("TOTAL", money(d.total))));
  parts.push(bytes(ESC, 0x45, 0x00));

  parts.push(textLine("--------------------------------"));
  parts.push(bytes(ESC, 0x61, 0x01));
  parts.push(textLine(`Paid: ${String(d.paymentMethod).toUpperCase()}`));
  parts.push(textLine("Thank you!"));
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

export async function printReceiptSmart(d: ThermalReceiptData) {
  const platform = Capacitor.getPlatform();
  const tauriRuntime = isTauriRuntime();

  // Default modes:
  // - Android -> bt (no popup)
  // - Desktop -> browser
  const storedMode = (localStorage.getItem(PRINTER_MODE_KEY) || "").trim();
  const mode = normalizePrinterMode(storedMode || (platform === "android" ? "bt" : "browser"), platform);

  const escpos = buildEscPos(d);

  // ✅ ANDROID
  if (platform === "android") {
    if (mode === "bt") {
      await printToBluetooth58mm(escpos, { chunkSize: 800, chunkDelayMs: 35, retries: 3 });
      return;
    }

    // tcp mode
    const ip = (localStorage.getItem(PRINTER_IP_KEY) || "").trim();
    const port = Number(localStorage.getItem(PRINTER_PORT_KEY) || "9100");
    if (!ip) {
      // Safe fallback: many devices are configured for BT but left on TCP accidentally.
      await printToBluetooth58mm(escpos, { chunkSize: 800, chunkDelayMs: 35, retries: 3 });
      return;
    }
    await sendTcp(ip, port, escpos);
    return;
  }

  // ✅ DESKTOP / WINDOWS
  if (mode === "browser") {
    // Windows app: if IP is configured, prefer native TCP print first.
    if (tauriRuntime) {
      const ip = (localStorage.getItem(PRINTER_IP_KEY) || "").trim();
      const port = Number(localStorage.getItem(PRINTER_PORT_KEY) || "9100");
      if (ip) {
        try {
          await sendTcpDesktopViaTauri(ip, port, escpos);
          return;
        } catch (e) {
          console.warn("[print] tauri tcp from browser-mode failed, falling back to browser print:", e);
        }
      }
    }
    await printBrowserReceipt(d);
    return;
  }

  if (mode === "tcp") {
    const ip = (localStorage.getItem(PRINTER_IP_KEY) || "").trim();
    const port = Number(localStorage.getItem(PRINTER_PORT_KEY) || "9100");
    if (!ip) {
      if (tauriRuntime) throw new Error("Printer IP not set for TCP mode");
      await printBrowserReceipt(d);
      return;
    }

    // Silent thermal print in Tauri desktop.
    if (tauriRuntime) {
      await sendTcpDesktopViaTauri(ip, port, escpos);
      return;
    }

    // Browser fallback (can't open raw TCP sockets)
    await printBrowserReceipt(d);
    return;
  }

  await printBrowserReceipt(d);
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
