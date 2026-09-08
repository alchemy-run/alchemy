import * as AWS from "@/AWS";
import { Cluster } from "@/AWS/DSQL/Cluster.ts";
import { withDsqlClient } from "@/AWS/DSQL/Migrations.ts";
import * as Drizzle from "@/Drizzle";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

const { test } = Test.make({
  providers: Layer.mergeAll(AWS.providers(), Drizzle.providers()),
});
const schema = new URL("./fixtures/migrations/schema.ts", import.meta.url)
  .pathname;

test.provider(
  "DSQL consumes Drizzle migrations, detects file changes, and preserves data",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const out = yield* fs.makeTempDirectoryScoped();
      const deploy = Effect.gen(function* () {
        const generated = yield* Drizzle.Schema("Schema", {
          schema,
          out,
          dialect: "postgres",
        });
        return yield* Cluster("Database", { migrations: generated.out });
      });
      const query = (endpoint: string, sql: string) =>
        withDsqlClient(endpoint, (client) =>
          Effect.tryPromise(() => client.query(sql)),
        );
      yield* Effect.gen(function* () {
        const created = yield* stack.deploy(deploy);
        const rows = yield* query(
          created.endpoint,
          "SELECT name, hash FROM __alchemy_migrations",
        );
        expect(rows.rows).toHaveLength(1);
        expect(rows.rows[0].hash).toMatch(/^[a-f0-9]{64}$/);
        const indexes = yield* query(
          created.endpoint,
          "SELECT indisvalid FROM pg_index WHERE indexrelid = 'users_email_idx'::regclass",
        );
        expect(indexes.rows[0].indisvalid).toBe(true);
        yield* query(
          created.endpoint,
          "INSERT INTO users(id, email) VALUES ('00000000-0000-0000-0000-000000000001', 'test@example.com')",
        );

        // A file addition at the same migrations path must trigger a resource update.
        const next = path.join(out, "20990101000000_evolve");
        yield* fs.makeDirectory(next);
        yield* fs.writeFileString(
          path.join(next, "migration.sql"),
          `
      ALTER TABLE users ADD COLUMN nickname text;
      ALTER TABLE users ADD COLUMN active boolean NOT NULL DEFAULT true;
      ALTER TABLE users DROP COLUMN nickname;
      ALTER TABLE users RENAME COLUMN email TO address;
    `,
        );
        const updated = yield* stack.deploy(deploy);
        expect(updated.clusterId).toBe(created.clusterId);
        expect(Object.keys(updated.migrationsHashes)).toHaveLength(2);
        const user = yield* query(
          updated.endpoint,
          "SELECT address, active FROM users",
        );
        expect(user.rows).toEqual([
          { address: "test@example.com", active: true },
        ]);
        yield* stack.deploy(deploy);
        const history = yield* query(
          updated.endpoint,
          "SELECT name FROM __alchemy_migrations",
        );
        expect(history.rows).toHaveLength(2);
      }).pipe(Effect.ensuring(stack.destroy().pipe(Effect.orDie)));
    }),
  { timeout: 120_000 },
);
