// File: src/lib/printQueue.ts
const KEY = "binancexi_thermal_print_queue_v1";

export type ThermalJob = {
  receiptNumber: string;
  timestamp: string;
  cashierName: string;
  customerName: string;
  paymentMethod: string;
  cart: any[];
  subtotal: number;
  discount: number;
  tax: number;
  total: number;
};

function readQueue(): ThermalJob[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) || "[]");
  } catch {
    return [];
  }
}

function writeQueue(q: ThermalJob[]) {
  localStorage.setItem(KEY, JSON.stringify(q || []));
}

export function enqueueThermalJob(job: ThermalJob) {
  const q = readQueue();
  q.push(job);
  writeQueue(q);
}

export function getThermalQueue(): ThermalJob[] {
  return readQueue();
}

export function clearThermalQueue() {
  writeQueue([]);
}

export function removeThermalJob(receiptNumber: string) {
  const q = readQueue().filter((j) => j.receiptNumber !== receiptNumber);
  writeQueue(q);
}
