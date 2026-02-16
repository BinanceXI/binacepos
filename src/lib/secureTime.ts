// Secure Time Service
// Uses multiple sources to get accurate time, preventing date manipulation

interface TimeSource {
  url: string;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: any;
  parseTime: (response: any) => number;
}

class SecureTimeService {
  private serverOffset: number = 0;
  private lastSync: number = 0;
  private readonly DEFAULT_SYNC_INTERVAL = 5 * 60 * 1000; // 5 minutes
  private readonly MAX_SYNC_INTERVAL = 30 * 60 * 1000; // 30 minutes
  private currentSyncInterval = this.DEFAULT_SYNC_INTERVAL;
  private isInitialized: boolean = false;
  private syncTimer: number | null = null;
  private lastWarnAt: number = 0;
  private readonly WARN_INTERVAL = 60 * 60 * 1000; // 1 hour

  private readonly CACHE_KEY = "binancexi_secure_time_v1";

  // Time sources to try (ordered)
  private timeSources: TimeSource[] = (() => {
    const url = (import.meta as any)?.env?.VITE_SUPABASE_URL as string | undefined;
    const anonKey = (import.meta as any)?.env?.VITE_SUPABASE_ANON_KEY as string | undefined;

    const supabaseUrl = String(url || "").replace(/\/+$/, "");
    const key = String(anonKey || "").trim();

    const supabaseHeaders =
      supabaseUrl && key
        ? {
            apikey: key,
            Authorization: `Bearer ${key}`,
            "Content-Type": "application/json",
          }
        : null;

    const sources: TimeSource[] = [];

    // 1) Supabase RPC (preferred, no external dependency)
    if (supabaseHeaders && supabaseUrl) {
      sources.push({
        url: `${supabaseUrl}/rest/v1/rpc/server_time`,
        method: "POST",
        headers: supabaseHeaders,
        body: {},
        parseTime: (data) => Number(data?.unix_ms ?? NaN),
      });
    }

    // 2) Supabase Edge Function (fallback)
    if (supabaseHeaders && supabaseUrl) {
      sources.push({
        url: `${supabaseUrl}/functions/v1/server_time`,
        method: "POST",
        headers: supabaseHeaders,
        body: {},
        parseTime: (data) => Number(data?.unix_ms ?? NaN),
      });
    }

    // 3) Last resort: public time API (often blocked/unreliable)
    sources.push({
      url: "https://worldtimeapi.org/api/timezone/Etc/UTC",
      method: "GET",
      parseTime: (data) => new Date(data?.utc_datetime).getTime(),
    });

    return sources;
  })();

  // Fallback: Use a calculated offset based on initial page load
  private initialLoadTime: number;
  private initialPerformanceNow: number;

  constructor() {
    this.initialLoadTime = Date.now();
    this.initialPerformanceNow = performance.now();
    this.loadCache();
    this.initialize();
  }

  private loadCache() {
    try {
      const raw = localStorage.getItem(this.CACHE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as any;
      const off = Number(parsed?.serverOffset);
      const last = Number(parsed?.lastSync);
      if (Number.isFinite(off)) this.serverOffset = off;
      if (Number.isFinite(last)) this.lastSync = last;
    } catch {
      // ignore
    }
  }

  private saveCache() {
    try {
      localStorage.setItem(
        this.CACHE_KEY,
        JSON.stringify({
          serverOffset: this.serverOffset,
          lastSync: this.lastSync,
          savedAt: Date.now(),
        })
      );
    } catch {
      // ignore
    }
  }

  private async initialize() {
    await this.syncTime();
    this.isInitialized = true;

    // Periodic sync with backoff.
    this.scheduleNextSync();
  }

  private scheduleNextSync() {
    if (this.syncTimer != null) window.clearTimeout(this.syncTimer);
    this.syncTimer = window.setTimeout(() => {
      void this.syncTime().finally(() => this.scheduleNextSync());
    }, this.currentSyncInterval);
  }

  private warnOnce(msg: string, extra?: any) {
    const now = Date.now();
    if ((import.meta as any)?.env?.DEV) {
      console.warn(msg, extra ?? "");
      return;
    }
    if (now - this.lastWarnAt < this.WARN_INTERVAL) return;
    this.lastWarnAt = now;
    console.warn(msg);
  }

  private async syncTime(): Promise<void> {
    // Try each time source
    for (const source of this.timeSources) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 3000);

        const response = await fetch(source.url, {
          method: source.method || "GET",
          signal: controller.signal,
          cache: "no-store",
          headers: source.headers,
          body: source.method === "POST" ? JSON.stringify(source.body ?? {}) : undefined,
        });
        clearTimeout(timeoutId);

        if (response.ok) {
          const data = await response.json().catch(() => ({}));
          const serverTime = Number(source.parseTime(data));
          if (!Number.isFinite(serverTime)) {
            throw new Error("Invalid time payload");
          }
          const localTime = Date.now();
          this.serverOffset = serverTime - localTime;
          this.lastSync = localTime;
          this.currentSyncInterval = this.DEFAULT_SYNC_INTERVAL;
          this.saveCache();

          if ((import.meta as any)?.env?.DEV) {
            console.log("[SecureTime] Synced, offset:", this.serverOffset);
          }
          return;
        }
      } catch (error) {
        this.warnOnce(`[SecureTime] Failed to sync with source: ${source.url}`);
      }
    }

    // Backoff on failure (cap at MAX).
    this.currentSyncInterval = Math.min(this.MAX_SYNC_INTERVAL, Math.max(this.DEFAULT_SYNC_INTERVAL, this.currentSyncInterval * 2));

    // Fallback: Use performance.now() to detect time manipulation
    // If local time doesn't match expected elapsed time, something is wrong
    const expectedElapsed = performance.now() - this.initialPerformanceNow;
    const actualElapsed = Date.now() - this.initialLoadTime;
    const drift = Math.abs(actualElapsed - expectedElapsed);
    
    if (drift > 60000) { // More than 1 minute drift
      console.warn('[SecureTime] Detected possible time manipulation, drift:', drift);
      // Use performance-based time instead
      this.serverOffset = (this.initialLoadTime + expectedElapsed) - Date.now();
    }
  }

  // Get current secure time
  public now(): Date {
    const adjustedTime = Date.now() + this.serverOffset;
    return new Date(adjustedTime);
  }

  // Get timestamp
  public timestamp(): number {
    return Date.now() + this.serverOffset;
  }

  // Format date
  public formatDate(format: 'date' | 'time' | 'datetime' | 'full' = 'datetime'): string {
    const date = this.now();
    
    switch (format) {
      case 'date':
        return date.toLocaleDateString('en-ZW', {
          year: 'numeric',
          month: 'short',
          day: 'numeric'
        });
      case 'time':
        return date.toLocaleTimeString('en-ZW', {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit'
        });
      case 'datetime':
        return date.toLocaleString('en-ZW', {
          year: 'numeric',
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit'
        });
      case 'full':
        return date.toLocaleString('en-ZW', {
          weekday: 'long',
          year: 'numeric',
          month: 'long',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit'
        });
    }
  }

  // Get today's date range for queries
  public getTodayRange(): { start: Date; end: Date } {
    const now = this.now();
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    const end = new Date(now);
    end.setHours(23, 59, 59, 999);
    return { start, end };
  }

  // Check if sync is current
  public isSynced(): boolean {
    const timeSinceSync = Date.now() - this.lastSync;
    return timeSinceSync < this.DEFAULT_SYNC_INTERVAL;
  }

  public getOffset(): number {
    return this.serverOffset;
  }
}

// Singleton instance
export const secureTime = new SecureTimeService();

// Hook for React components
import { useState, useEffect } from 'react';

export function useSecureTime(updateInterval: number = 1000) {
  const [time, setTime] = useState(secureTime.now());

  useEffect(() => {
    const interval = setInterval(() => {
      setTime(secureTime.now());
    }, updateInterval);

    return () => clearInterval(interval);
  }, [updateInterval]);

  return {
    now: time,
    timestamp: secureTime.timestamp(),
    formatDate: secureTime.formatDate.bind(secureTime),
    isSynced: secureTime.isSynced(),
    getTodayRange: secureTime.getTodayRange.bind(secureTime)
  };
}
