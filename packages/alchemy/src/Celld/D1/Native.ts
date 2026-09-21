/** Metadata returned by Celld's native D1 engine. */
export interface D1Meta {
  duration: number;
  changes: number;
  last_row_id: number;
  rows_read: number;
  rows_written: number;
  size_after: number;
  changed_db: boolean;
  served_by: string;
  served_by_region: string;
  served_by_primary: boolean;
  /** Additional engine metadata is preserved without transformation. */
  [key: string]: unknown;
}

/** Native D1 query envelope; null values and row property names are preserved. */
export interface D1Result<T = unknown> {
  success: boolean;
  results: T[];
  meta: D1Meta;
}

/** Native exec counts statements and reports elapsed milliseconds. */
export interface D1ExecResult {
  count: number;
  duration: number;
}

/** Celld-owned structural contract for the isolate's prepared statement. */
export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  all<T = unknown>(): Promise<D1Result<T>>;
  run<T = unknown>(): Promise<D1Result<T>>;
  first<T = unknown>(column?: string): Promise<T | null>;
  raw<T = unknown[]>(): Promise<T[]>;
  raw<T = unknown[]>(options: {
    columnNames: true;
  }): Promise<[string[], ...T[]]>;
}

/** Celld-owned structural contract for the isolate's native database binding. */
export interface D1Database {
  prepare(sql: string): D1PreparedStatement;
  exec(sql: string): Promise<D1ExecResult>;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
  withSession(constraintOrBookmark?: string): D1DatabaseSession;
  dump(): Promise<ArrayBuffer>;
}

/** Native sessions expose a stable primary bookmark after successful queries. */
export interface D1DatabaseSession {
  prepare(sql: string): D1PreparedStatement;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
  getBookmark(): string | null;
}
