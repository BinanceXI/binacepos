import { Capacitor } from "@capacitor/core";

declare global {
  interface Window {
    bluetoothSerial?: any;
  }
}

function isAndroidNative() {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android";
}

const BT_LAST_ADDRESS_KEY = "binancexi_printer_bt_address";

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

function withTimeout<T>(p: Promise<T>, timeoutMs: number, msg: string) {
  let t: any;
  const timeout = new Promise<T>((_, reject) => {
    t = setTimeout(() => reject(new Error(msg)), timeoutMs);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(t));
}

function pickPrinter(devices: any[]) {
  const saved = localStorage.getItem(BT_LAST_ADDRESS_KEY) || "";
  const savedMatch = saved ? devices.find((d) => String(d.address || "") === saved) : null;
  if (savedMatch) return savedMatch;

  const byName = (needle: string) =>
    devices.find((d) => String(d.name || "").toLowerCase().includes(needle));

  return (
    byName("pos") ||
    byName("printer") ||
    byName("xp-") ||
    byName("xprinter") ||
    byName("sp") ||
    devices[0]
  );
}

async function btList(bt: any) {
  return await new Promise<any[]>((resolve, reject) => bt.list(resolve, reject));
}

async function btDisconnect(bt: any) {
  try {
    await new Promise<void>((resolve) => bt.disconnect(resolve, resolve));
  } catch {
    // ignore
  }
}

async function btConnect(bt: any, address: string) {
  await withTimeout(
    new Promise<void>((resolve, reject) => {
      // Some printers need insecure connect. We'll try connect(), then fallback if available.
      let done = false;
      const ok = () => {
        if (done) return;
        done = true;
        resolve();
      };
      const fail = async (e: any) => {
        if (done) return;
        done = true;

        if (typeof bt.connectInsecure === "function") {
          try {
            await new Promise<void>((res, rej) => bt.connectInsecure(address, res, rej));
            resolve();
            return;
          } catch {
            // fall through to reject below
          }
        }

        reject(e);
      };

      bt.connect(address, ok, fail);
    }),
    10_000,
    "Bluetooth connect timed out"
  );
}

async function btWrite(bt: any, data: ArrayBuffer) {
  await withTimeout(
    new Promise<void>((resolve, reject) => bt.write(data, resolve, reject)),
    10_000,
    "Bluetooth write timed out"
  );
}

export type BluetoothPrintOptions = {
  chunkSize?: number; // bytes (512–1024 recommended)
  chunkDelayMs?: number;
  retries?: number;
};

export async function printToBluetooth58mm(data: Uint8Array, opts: BluetoothPrintOptions = {}) {
  if (!isAndroidNative()) {
    throw new Error("Bluetooth printing only supported on Android app");
  }

  const bt = window.bluetoothSerial;
  if (!bt) throw new Error("Bluetooth plugin missing (cordova-plugin-bluetooth-serial)");

  const chunkSize = Math.max(512, Math.min(1024, Math.trunc(opts.chunkSize ?? 800)));
  const chunkDelayMs = Math.max(5, Math.trunc(opts.chunkDelayMs ?? 35));
  const retries = Math.max(1, Math.trunc(opts.retries ?? 3));

  const devices = await btList(bt);
  if (!devices?.length) {
    throw new Error("No paired Bluetooth devices found. Pair the printer in Android settings first.");
  }

  const printer = pickPrinter(devices);
  const address = String(printer?.address || "").trim();
  if (!address) throw new Error("Printer address not found. Pair the printer again in Android settings.");

  let lastErr: any = null;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      // Best-effort: clean slate between attempts
      await btDisconnect(bt);
      await btConnect(bt, address);

      for (let i = 0; i < data.length; i += chunkSize) {
        const chunk = data.slice(i, i + chunkSize); // creates a new buffer
        await btWrite(bt, chunk.buffer);
        await sleep(chunkDelayMs);
      }

      // Give the printer a moment to flush before disconnect.
      await sleep(200);
      localStorage.setItem(BT_LAST_ADDRESS_KEY, address);
      await btDisconnect(bt);
      return;
    } catch (e: any) {
      lastErr = e;
      await btDisconnect(bt);
      await sleep(250 * attempt);
    }
  }

  throw new Error(lastErr?.message || "Bluetooth print failed");
}
