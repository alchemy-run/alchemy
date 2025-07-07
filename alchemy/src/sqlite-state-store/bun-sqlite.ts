import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import type { Scope } from "../scope.ts";
import { BaseSQLiteStateStore } from "./base.ts";
import { migrations } from "./internal/migrations.ts";
import * as schema from "./internal/schema.ts";

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
