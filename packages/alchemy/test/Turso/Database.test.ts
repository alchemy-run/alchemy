import * as turso from "@distilled.cloud/turso/turso";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Test from "@/Test/Alchemy";
import * as Turso from "@/Turso";
import { organization } from "@/Turso/Credentials";
import * as Hrana from "@/Turso/Hrana";

const { test } = Test.make({ providers: Turso.providers() });

const fixture = (name: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    return path.join(import.meta.dirname, "fixtures", name);
  });

/** Query a database out-of-band with a short-lived token. */
const sql = (database: string, hostname: string, statement: string) =>
  Effect.gen(function* () {
    const org = yield* organization;
    const { jwt } = yield* turso.createDatabaseToken({
      organizationSlug: org,
      databaseName: database,
      expiration: "5m",
    });
    return yield* Hrana.query({ url: `https://${hostname}`, authToken: jwt! }, statement);
  });

const expectDatabaseGone = (name: string) =>
  Effect.gen(function* () {
    const org = yield* organization;
    const exists = yield* turso.getDatabase({ organizationSlug: org, databaseName: name }).pipe(
      Effect.map(() => true),
      Effect.catchTag("NotFound", () => Effect.succeed(false)),
      Effect.repeat({ schedule: Schedule.spaced("1 second"), until: (e) => !e, times: 10 }),
    );
    expect(exists).toBe(false);
  });

test.provider(
  "create, configure, migrate, seed, and delete a database",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const org = yield* organization;
      const migrations = yield* fixture("migrations");
      const seed = yield* fixture("seed/users.sql");

      const app = (props: Partial<Turso.DatabaseProps>) =>
        Effect.gen(function* () {
          const group = yield* Turso.Group("Group", { location: "aws-us-east-1" });
          const db = yield* Turso.Database("Db", { group: group.name, ...props });
          return { group, db };
        });

      const { group, db } = yield* stack.deploy(app({}));
      expect(db.group).toBe(group.name);
      expect(db.url).toBe(`libsql://${db.hostname}`);
      expect(db.hostname).toContain(`-${org}.`);
      expect(db.blockWrites).toBe(false);
      expect(db.deleteProtection).toBe(false);

      // Configuration converges in place.
      const configured = yield* stack.deploy(
        app({ blockWrites: true, blockReads: true, deleteProtection: true }),
      );
      expect(configured.db.dbId).toBe(db.dbId);
      const config = yield* turso.getDatabaseConfiguration({
        organizationSlug: org,
        databaseName: db.name,
      });
      expect(config.block_writes).toBe(true);
      expect(config.block_reads).toBe(true);
      expect(config.delete_protection).toBe(true);

      // Removing the props reverts them.
      const reverted = yield* stack.deploy(app({}));
      expect(reverted.db.blockWrites).toBe(false);
      expect(reverted.db.blockReads).toBe(false);
      expect(reverted.db.deleteProtection).toBe(false);

      // Migrations, then SQL imports.
      const migrated = yield* stack.deploy(app({ migrations, importFiles: [seed] }));
      expect(Object.keys(migrated.db.migrationsHashes)).toHaveLength(2);
      expect(Object.keys(migrated.db.importHashes)).toEqual([seed]);
      const users = yield* sql(db.name, db.hostname, "SELECT name FROM users ORDER BY id");
      expect(users).toEqual([{ name: "alice" }, { name: "bob" }]);
      const posts = yield* sql(db.name, db.hostname, "SELECT count(*) AS n FROM posts");
      expect(posts).toEqual([{ n: 0 }]);
      const applied = yield* sql(
        db.name,
        db.hostname,
        "SELECT count(*) AS n FROM __alchemy_migrations",
      );
      expect(applied).toEqual([{ n: 2 }]);

      // A redeploy with unchanged files does not re-run the imports
      // (re-running them would violate the primary key).
      yield* stack.deploy(app({ migrations, importFiles: [seed] }));

      yield* stack.destroy();
      yield* expectDatabaseGone(db.name);
    }),
  { tags: ["provider:turso", "provider:turso:database", "live"], timeout: 180_000 },
);

test.provider(
  "moving a database to another group replaces it",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const app = (target: "A" | "B") =>
        Effect.gen(function* () {
          // Keep both groups deployed across the replacement.
          const a = yield* Turso.Group("GroupA", { location: "aws-us-east-1" });
          const b = yield* Turso.Group("GroupB", { location: "aws-us-east-1" });
          return yield* Turso.Database("Db", { group: target === "A" ? a.name : b.name });
        });

      const first = yield* stack.deploy(app("A"));
      const second = yield* stack.deploy(app("B"));
      expect(second.dbId).not.toBe(first.dbId);
      expect(second.group).not.toBe(first.group);
      yield* expectDatabaseGone(first.name);

      yield* stack.destroy();
      yield* expectDatabaseGone(second.name);
    }),
  { tags: ["provider:turso", "provider:turso:database", "live"], timeout: 180_000 },
);

test.provider(
  "fork a database from another with seed",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const migrations = yield* fixture("migrations");
      const seed = yield* fixture("seed/users.sql");

      const app = (withFork: boolean) =>
        Effect.gen(function* () {
          const group = yield* Turso.Group("Group", { location: "aws-us-east-1" });
          const source = yield* Turso.Database("Source", {
            group: group.name,
            migrations,
            importFiles: [seed],
          });
          const fork = withFork
            ? yield* Turso.Database("Fork", {
                group: group.name,
                seed: { type: "database", name: source.name },
              })
            : undefined;
          return { source, fork };
        });

      // Deploy the source first so the fork copies its seeded data.
      yield* stack.deploy(app(false));
      const { fork } = yield* stack.deploy(app(true));
      const users = yield* sql(fork!.name, fork!.hostname, "SELECT name FROM users ORDER BY id");
      expect(users).toEqual([{ name: "alice" }, { name: "bob" }]);

      yield* stack.destroy();
      yield* expectDatabaseGone(fork!.name);
    }),
  { tags: ["provider:turso", "provider:turso:database", "live"], timeout: 180_000 },
);

test.provider(
  "a failing import rolls back and leaves no partial schema",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const broken = yield* fixture("seed/broken.sql");

      const app = (importFiles: string[]) =>
        Effect.gen(function* () {
          const group = yield* Turso.Group("Group", { location: "aws-us-east-1" });
          return yield* Turso.Database("Db", { group: group.name, importFiles });
        });

      const db = yield* stack.deploy(app([]));
      const error = yield* stack.deploy(app([broken])).pipe(Effect.flip);
      expect(String(error)).toContain("missing_table");
      const tables = yield* sql(
        db.name,
        db.hostname,
        "SELECT name FROM sqlite_master WHERE name = 'half_applied'",
      );
      expect(tables).toEqual([]);

      yield* stack.destroy();
      yield* expectDatabaseGone(db.name);
    }),
  { tags: ["provider:turso", "provider:turso:database", "live"], timeout: 180_000 },
);
