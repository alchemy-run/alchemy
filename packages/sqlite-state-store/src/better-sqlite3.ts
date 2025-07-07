import type { Scope } from "alchemy";
import Client, { type Options } from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { BaseSQLiteStateStore } from "./base";
import { migrations } from "./internal/migrations";
import * as schema from "./internal/schema";

interface BetterSQLite3StateStoreOptions {
  filename?: string;
  options?: Options;
}

export class BetterSQLite3StateStore extends BaseSQLiteStateStore {
  constructor(scope: Scope, options: BetterSQLite3StateStoreOptions = {}) {
    super(scope, {
      create: async () => {
        if (typeof globalThis.Bun !== "undefined") {
          throw new Error(
            "BetterSQLite3StateStore is only supported in Node.js",
          );
        }
        const db = drizzle(
          new Client(
            options.filename ??
              process.env.ALCHEMY_STATE_FILE ??
              ".alchemy/state.sqlite",
            options.options,
          ),
          {
            schema,
          },
        );
        // @ts-expect-error - internal drizzle properties
        db.dialect.migrate(migrations, db.session, {
          migrationsFolder: "drizzle",
        });
        return db;
      },
    });
  }
}
