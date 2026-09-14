export interface AnalyticsEngineServiceProps {
  dataset: string;
}

/** Binary blobs are represented losslessly in local JSON inspection responses. */
export type AnalyticsBlob = string | null | { base64: string };
export interface AnalyticsPoint {
  indexes: AnalyticsBlob[];
  blobs: AnalyticsBlob[];
  doubles: number[];
}

export interface LocalAnalyticsEngineInspector {
  /** Latest points, in insertion order, with an optional exclusive sequence cursor. */
  getDataPoints(options?: { limit?: number; after?: number }): Promise<{
    data: Array<AnalyticsPoint & { sequence: number; timestamp: number }>;
    cursor?: number;
  }>;
  /** Run a SQLite SELECT against the dataset name (production uses ClickHouse). */
  query(
    sql: string,
  ): Promise<{ data: Array<Record<string, unknown>>; rows: number }>;
}
