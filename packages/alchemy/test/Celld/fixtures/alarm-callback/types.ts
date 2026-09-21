export type LegacyRow = {
  id: string;
  run_at: number;
  repeat_ms: number | null;
  payload: string;
};

export interface Bookkeeping {
  schemaChecks: number;
  reconciliations: number;
  setAlarm: number;
  deleteAlarm: number;
}

export interface Snapshot {
  version: "v1" | "v2";
  id: string;
  boots: number;
  delivered: string[];
  attempts: number;
  recovery: number | null;
  marker: string | null;
  cleanupWrite: string | null;
  rows: { value: string }[];
  pending: { id: string }[];
  legacy: LegacyRow[];
  schemaVersion: number | null;
  alarm: number | null;
  userAlarmAfterCallbacks: boolean;
  bookkeeping: Bookkeeping | null;
  transaction: {
    failure: string;
    alarmBefore: number | null;
    alarmAfter: number | null;
    cleanupFinished: boolean;
  } | null;
}
