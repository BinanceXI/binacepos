// Secure Time Service
// Uses multiple sources to get accurate time, preventing date manipulation

interface TimeSource {
  url: string;
  parseTime: (response: any) => number;
}

class SecureTimeService {
  private serverOffset: number = 0;
  private lastSync: number = 0;
  private readonly SYNC_INTERVAL = 5 * 60 * 1000; // 5 minutes
  private isInitialized: boolean = false;

  // Time sources to try
  private timeSources: TimeSource[] = [
    {
      url: 'https://worldtimeapi.org/api/timezone/Etc/UTC',
      parseTime: (data) => new Date(data.utc_datetime).getTime()
    },
  ];

  // Fallback: Use a calculated offset based on initial page load
  private initialLoadTime: number;
  private initialPerformanceNow: number;

  constructor() {
    this.initialLoadTime = Date.now();
    this.initialPerformanceNow = performance.now();
    this.initialize();
  }

  private async initialize() {
    await this.syncTime();
    this.isInitialized = true;
    
    // Periodic sync
    setInterval(() => this.syncTime(), this.SYNC_INTERVAL);
  }

  private async syncTime(): Promise<void> {
    // Try each time source
    for (const source of this.timeSources) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 3000);

        const response = await fetch(source.url, { 
          signal: controller.signal,
          cache: 'no-store'
        });
        clearTimeout(timeoutId);

        if (response.ok) {
          const data = await response.json();
          const serverTime = source.parseTime(data);
          const localTime = Date.now();
          this.serverOffset = serverTime - localTime;
          this.lastSync = localTime;
          console.log('[SecureTime] Synced with server, offset:', this.serverOffset);
          return;
        }
      } catch (error) {
        console.warn('[SecureTime] Failed to sync with source:', source.url);
      }
    }

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
    return timeSinceSync < this.SYNC_INTERVAL;
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
