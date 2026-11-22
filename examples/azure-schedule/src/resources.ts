import * as Azure from "@alchemy.run/azure";
import * as Effect from "effect/Effect";

/** The storage account the schedules report into. */
export const Data = Azure.Storage.StorageAccount("Data", { sku: "Standard_LRS" });

/**
 * One blob per scheduled run:
 *
 * - `heartbeats/<ISO time>.json` — one per minute.
 * - `reports/<YYYY-MM-DD>.json` — one per day, the heartbeat count of the
 *   24 hours before it ran.
 */
export const Runs = Effect.gen(function* () {
  const account = yield* Data;
  return yield* Azure.Storage.BlobContainer("Runs", {
    storageAccount: account.storageAccountName,
  });
});

/** The body of a heartbeat blob. */
export interface Heartbeat {
  /** When the handler ran (ISO 8601). */
  at: string;
  /** Whether the Functions host ran this occurrence late. */
  isPastDue: boolean;
}

/** The body of a daily report blob. */
export interface DailyReport {
  /** When the handler ran (ISO 8601). */
  at: string;
  /** Heartbeats recorded in the 24 hours before `at`. */
  heartbeats: number;
}

export const HEARTBEATS = "heartbeats/";
export const REPORTS = "reports/";

/** `2026-10-25T09:30:00.000Z` → `heartbeats/2026-10-25T09:30:00.000Z.json`. */
export const heartbeatKey = (at: string) => `${HEARTBEATS}${at}.json`;

/** `2026-10-25T00:00:00.000Z` → `reports/2026-10-25.json`. */
export const reportKey = (at: string) => `${REPORTS}${at.slice(0, 10)}.json`;
