import type * as Effect from "effect/Effect";
import * as ServiceMap from "effect/ServiceMap";

import type { SQLiteConnection } from "./SQLiteConnection.ts";
import type { SQLiteErrorType } from "./SQLiteError.ts";

export class SQLite extends ServiceMap.Service<SQLite, SQLiteService>()(
  "SQLite",
) {}

/**
 * SQLite service that provides database connection factory.
 */
export interface SQLiteService {
  /**
   * Open a SQLite database at the given path.
   */
  open(path: string): Effect.Effect<SQLiteConnection, SQLiteErrorType>;
}
