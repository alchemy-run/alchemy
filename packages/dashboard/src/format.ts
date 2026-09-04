import { useEffect, useState } from "react";

/** "312ms" / "4.2s" / "3m 12s" / "1h 4m" */
export const formatDuration = (ms: number): string => {
  if (!Number.isFinite(ms) || ms < 0) {
    return "—";
  }
  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }
  const seconds = ms / 1000;
  if (seconds < 60) {
    return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ${Math.round(seconds % 60)}s`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
};

/** "just now" / "4m ago" / "2h ago" / "3d ago" */
export const formatRelative = (ts: number, now: number): string => {
  const delta = now - ts;
  if (delta < 45_000) {
    return "just now";
  }
  const minutes = Math.round(delta / 60_000);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  return `${Math.round(hours / 24)}d ago`;
};

/** Local wall-clock time, e.g. "14:03:22". */
export const formatTime = (ts: number): string =>
  new Date(ts).toLocaleTimeString();

/** Local date + time, e.g. "6/30/2026, 14:03:22". */
export const formatDateTime = (ts: number): string =>
  new Date(ts).toLocaleString();

/**
 * A ticking `Date.now()` that only ticks while `active` — used so live
 * durations update every second but historical/finished ones render once.
 */
export const useNow = (intervalMs: number, active: boolean): number => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) {
      return;
    }
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs, active]);
  return now;
};
