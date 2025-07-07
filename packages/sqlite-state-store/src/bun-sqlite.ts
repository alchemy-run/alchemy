import { Database } from "bun:sqlite";
import type { Scope } from "alchemy";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { BaseSQLiteStateStore } from "./base";
import { migrations } from "./internal/migrations";
import * as schema from "./internal/schema";

interface BunSQLiteStateStoreOptions {
  filename?: string;
}

export class BunSQLiteStateStore extends BaseSQLiteStateStore {
  constructor(scope: Scope, options: BunSQLiteStateStoreOptions = {}) {
    super(scope, {
      create: async () => {
        const db = drizzle(
          new Database(
            options.filename ??
              process.env.ALCHEMY_STATE_FILE ??
              ".alchemy/state.sqlite",
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
