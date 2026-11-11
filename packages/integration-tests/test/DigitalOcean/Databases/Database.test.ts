import * as DigitalOcean from "@alchemy.run/digitalocean";
import { withMySqlExecutor, withPgExecutor } from "@alchemy.run/sql/Migrations";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import { getDatabase, getDatabaseCluster } from "@distilled.cloud/digitalocean";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import { isGone, logLevel, skipSlow } from "../support.ts";

const { test } = Test.make({ providers: DigitalOcean.providers() });

const LIVE_TAGS = ["provider:digitalocean", "provider:digitalocean:databases", "live"];
const LIVE_TIMEOUT = 1_800_000;

const rows = (engine: "pg" | "mysql", uri: Redacted.Redacted<string>, sql: string) => {
  const url = new URL(Redacted.value(uri));
  const config = {
    host: url.hostname,
    port: Number(url.port),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: "app",
    ssl: { rejectUnauthorized: false },
  };
  return engine === "pg"
    ? withPgExecutor(config, (executor) => executor.query(sql))
    : withMySqlExecutor(config, (executor) => executor.query(sql));
};

const migrationsLifecycle = (engine: "pg" | "mysql") =>
  test.provider.skipIf(skipSlow)(
    `${engine} database: apply migrations, apply only a new file, plan noop, destroy`,
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "do-migrations-" });
        yield* fs.writeFileString(
          path.join(dir, "0001_init.sql"),
          "CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT);",
        );

        const declare = Effect.gen(function* () {
          const cluster = yield* DigitalOcean.Databases.Cluster("Cluster", {
            engine,
            size: "db-s-1vcpu-1gb",
            region: "nyc3",
          });
          const database = yield* DigitalOcean.Databases.Database("App", {
            clusterId: cluster.clusterId,
            name: "app",
            migrations: dir,
          });
          return { cluster, database };
        });

        const first = yield* stack.deploy(declare);
        expect(Object.keys(first.database.migrationsHashes)).toEqual(["0001_init.sql"]);
        const uri = first.cluster.uri!;
        expect(yield* rows(engine, uri, "SELECT COUNT(*) AS n FROM __alchemy_migrations")).toEqual([
          { n: engine === "pg" ? "1" : 1 },
        ]);

        yield* fs.writeFileString(
          path.join(dir, "0002_tags.sql"),
          "CREATE TABLE tags (id INTEGER PRIMARY KEY, name TEXT);",
        );
        const second = yield* stack.deploy(declare);
        expect(Object.keys(second.database.migrationsHashes).sort()).toEqual([
          "0001_init.sql",
          "0002_tags.sql",
        ]);
        expect(yield* rows(engine, uri, "SELECT COUNT(*) AS n FROM tags")).toEqual([
          { n: engine === "pg" ? "0" : 0 },
        ]);

        const plan = yield* stack.plan(declare);
        expect(plan.resources.App).toMatchObject({ action: "noop" });

        yield* stack.destroy();

        expect(
          yield* isGone(getDatabaseCluster({ database_cluster_uuid: first.cluster.clusterId })),
        ).toBe(true);
        expect(
          yield* isGone(
            getDatabase({ database_cluster_uuid: first.cluster.clusterId, database_name: "app" }),
          ),
        ).toBe(true);
      }).pipe(logLevel),
    { tags: LIVE_TAGS, timeout: LIVE_TIMEOUT },
  );

migrationsLifecycle("pg");
migrationsLifecycle("mysql");
