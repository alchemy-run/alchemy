/**
 * The Domain host on the Effect Cluster `Sharding` of the current process
 * (`DomainCluster.layerSharding`), against a real Postgres. Runs only when
 * its database URL is set:
 *
 *   DOMAIN_TEST_POSTGRES_URL=postgres://postgres@localhost:5432/postgres
 *
 * The role must be allowed to create databases: each run makes a database
 * of its own and drops it at the end.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Domain from "@alchemy.run/domain";
import * as DomainCluster from "@alchemy.run/domain/EffectCluster";
import { afterAll, beforeAll, describe, expect, it } from "@alchemy.run/test";
import { PgClient } from "@effect/sql-pg";
import { ClusterWorkflowEngine, SingleRunner } from "effect/cluster";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { SqlClient } from "effect/sql/SqlClient";
import { conformance } from "../Domain/conformance/conformance.ts";
import { Counter, ConformanceLive, Increment } from "../Domain/conformance/model.ts";

const URL_ = process.env.DOMAIN_TEST_POSTGRES_URL;
const RUN = `domain_sharding_${Date.now().toString(36)}`;

/** The URL of `database` on the same server. */
const urlOf = (database: string) => {
  const url = new URL(URL_ ?? "postgres://localhost/postgres");
  url.pathname = `/${database}`;
  return url.toString();
};

const admin = <A, E>(effect: Effect.Effect<A, E, SqlClient>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(PgClient.layer({ url: Redacted.make(URL_ ?? ""), maxConnections: 1 })),
    ),
  );

/** Make a fresh database for one block of tests; dropped once the file ends. */
const databases: Array<string> = [];
const freshDatabase = async (suffix: string) => {
  const name = `${RUN}_${suffix}_${crypto.randomUUID().slice(0, 6)}`;
  await admin(
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      yield* sql.unsafe(`CREATE DATABASE ${name}`);
    }),
  );
  databases.push(name);
  return urlOf(name);
};

const sqlLayer = (url: string) => PgClient.layer({ url: Redacted.make(url), maxConnections: 4 });

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, () => {
      const address = server.address();
      server.close(() => resolve(typeof address === "object" && address ? address.port : 0));
    });
  });

/** Wait until the runner serves a read of the model, or fail once it exits. */
const ready = async (url: string, child: ChildProcess, key = "ready-probe") => {
  for (let attempt = 0; attempt < 120; attempt++) {
    if (child.exitCode !== null) throw new Error(`the runner exited with ${child.exitCode}`);
    const response = await fetch(`${url}/counter/${key}`, {
      signal: AbortSignal.timeout(90_000),
    }).catch(() => undefined);
    if (response?.status === 200) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${url} is not ready`);
};

/** A runner of the conformance model in a process of its own, serving the routes. */
const children: Array<ChildProcess> = [];
const startRunner = async (databaseUrl: string, label: string): Promise<string> => {
  // A port picked free can be taken before the runner binds it: try again on others.
  for (let attempt = 1; ; attempt++) {
    const [runnerPort, frontPort] = [await freePort(), await freePort()];
    // The runner writes its log to a file of its own: a pipe the test
    // process must drain could fill and stall it.
    const log = openSync(join(tmpdir(), `${RUN}-${label}-${attempt}.log`), "w");
    const child = spawn(
      process.execPath,
      [new URL("./fixtures/domain-sharding/runner.ts", import.meta.url).pathname],
      {
        env: {
          ...process.env,
          DATABASE_URL: databaseUrl,
          RUNNER_PORT: String(runnerPort),
          FRONT_PORT: String(frontPort),
          RUNNER_NAME: `${RUN}-${label}`,
        },
        stdio: ["ignore", log, log],
      },
    );
    closeSync(log);
    children.push(child);
    const url = `http://localhost:${frontPort}`;
    try {
      await ready(url, child);
      return url;
    } catch (error) {
      child.kill("SIGTERM");
      if (attempt === 3 || child.exitCode === null) throw error;
    }
  }
};

/** The deploy step: the storage table, made once before any runner starts. */
const migrateDatabase = (url: string) =>
  Effect.runPromise(
    Layer.build(DomainCluster.layerMigrations).pipe(Effect.scoped, Effect.provide(sqlLayer(url))),
  );

afterAll(async () => {
  for (const child of children) child.kill("SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, 500));
  for (const name of databases)
    await admin(
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        yield* sql.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      }),
    );
}, 60_000);

/** The conformance suite's `test`, on the live clock with an HTTP client. */
const test = (
  name: string,
  effect: Effect.Effect<void, any, any>,
  options?: { readonly timeout?: number; readonly tags?: ReadonlyArray<string> },
) =>
  it.live(
    name,
    () => effect.pipe(Effect.provide(FetchHttpClient.layer)) as Effect.Effect<void, unknown>,
    options,
  );

describe.skipIf(URL_ === undefined)(
  "Domain on Effect Cluster, in one process",
  { tags: ["local"] },
  () => {
    let url = "";
    beforeAll(async () => {
      const database = await freshDatabase("one");
      await migrateDatabase(database);
      url = await startRunner(database, "one");
    }, 120_000);
    conformance({ test, url: Effect.sync(() => url), kind: "local" });
  },
);

describe.skipIf(URL_ === undefined)(
  "Domain on Effect Cluster, in two processes on one Postgres",
  { tags: ["local"] },
  () => {
    let url = "";
    let database = "";
    beforeAll(async () => {
      database = await freshDatabase("two");
      await migrateDatabase(database);
      await startRunner(database, "two-a");
      url = await startRunner(database, "two-b");
      // The second runner takes over half the shards: wait until it serves them.
      for (let i = 0; i < 8; i++) await ready(url, children.at(-1)!, `warm-${i}`);
    }, 300_000);
    conformance({ test, url: Effect.sync(() => url), kind: "local" });

    it.live(
      "both runners hold shards",
      () =>
        Effect.gen(function* () {
          const sql = yield* SqlClient;
          // Effect Cluster holds each shard it owns as an advisory lock. A
          // runner a health check missed gets its shards back at the next one.
          const holders = sql<{ name: string }>`
            SELECT DISTINCT a.application_name AS name
            FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
            WHERE l.locktype = 'advisory' AND a.datname = current_database()
            ORDER BY name`.pipe(Effect.map((rows) => rows.map((row) => row.name)));
          const both = [`${RUN}-two-a`, `${RUN}-two-b`];
          const seen = yield* holders.pipe(
            Effect.repeat({
              schedule: Schedule.spaced("1 second"),
              until: (names) => names.length === 2,
              times: 150,
            }),
          );
          expect(seen).toEqual(both);
        }).pipe(Effect.provide(sqlLayer(database))),
      { timeout: 180_000 },
    );
  },
);

// A second model with an aggregate of the same name as the conformance one.
class Added extends Domain.Event("Added", { by: Schema.Int }) {}
class Add extends Domain.Command("Add", {
  target: Schema.String,
  input: { by: Schema.Int },
  events: [Added],
}) {}
class OtherCounter extends Domain.Aggregate("Counter", {
  id: Schema.String,
  state: Schema.Struct({ total: Schema.Int }),
  initial: { total: 0 },
  commands: [Add],
  decide: { Add: (_, command) => [new Added({ by: command.by })] },
  evolve: { Added: (state, event) => ({ total: state.total + event.by }) },
}) {}
class Other extends Domain.Model("Other", { aggregates: [OtherCounter] }) {}

/** One runner in this process: `SingleRunner` and its workflow engine over `url`. */
const singleRunner = (url: string) =>
  ClusterWorkflowEngine.layer.pipe(
    Layer.provideMerge(SingleRunner.layer({ runnerStorage: "memory" })),
    Layer.provideMerge(Layer.merge(sqlLayer(url), Digest.layerWebCrypto)),
  );

const tableExists = Effect.gen(function* () {
  const sql = yield* SqlClient;
  const rows = yield* sql<{
    found: string | null;
  }>`SELECT to_regclass('alchemy_domain_objects')::text AS found`;
  return rows[0]?.found !== null && rows[0]?.found !== undefined;
});

describe.skipIf(URL_ === undefined)(
  "Domain on Effect Cluster, on a Sharding of its caller",
  { tags: ["local"] },
  () => {
    it.live(
      "the runner makes no table; the migrations Layer does",
      () =>
        Effect.gen(function* () {
          const url = yield* Effect.promise(() => freshDatabase("nomigrate"));
          const hosted = ConformanceLive.pipe(
            Layer.provide(DomainCluster.layerSharding({ name: "NoMigrate" })),
          );
          const before = yield* Effect.gen(function* () {
            yield* Counter;
            return yield* tableExists;
          }).pipe(Effect.provide(hosted), Effect.provide(singleRunner(url)));
          expect(before).toBe(false);
          const after = yield* Effect.andThen(
            Layer.build(DomainCluster.layerMigrations),
            tableExists,
          ).pipe(Effect.scoped, Effect.provide(sqlLayer(url)));
          expect(after).toBe(true);
        }),
      { timeout: 60_000 },
    );

    it.live(
      "two models on one Sharding keep their own state",
      () =>
        Effect.gen(function* () {
          const url = yield* Effect.promise(() => freshDatabase("twomodels"));
          yield* Effect.promise(() => migrateDatabase(url));
          // Both on one entity, each through a Layer of its own, and a third
          // copy of the first model on an entity of its own.
          const conformance = ConformanceLive.pipe(
            Layer.provide(DomainCluster.layerSharding({ name: "Shared" })),
          );
          const other = Other.layer(Layer.empty).pipe(
            Layer.provide(DomainCluster.layerSharding({ name: "Shared" })),
          );
          // Each model in a context of its own (both name their aggregate
          // `Counter`), on the same Sharding.
          yield* Effect.gen(function* () {
            const counters = Context.get(yield* Layer.build(conformance), Counter);
            const others = Context.get(yield* Layer.build(other), OtherCounter);
            yield* counters.send("x", new Increment({ by: 2 }));
            yield* others.send("x", new Add({ by: 5 }));
            yield* counters.send("x", new Increment({ by: 1 }));
            expect(yield* counters.get("x")).toEqual({ total: 3 });
            expect(yield* others.get("x")).toEqual({ total: 5 });
          }).pipe(Effect.scoped, Effect.provide(singleRunner(url)));
          const apart = yield* Effect.gen(function* () {
            const counters = yield* Counter;
            yield* counters.send("x", new Increment({ by: 4 }));
            return yield* counters.get("x");
          }).pipe(
            Effect.provide(
              ConformanceLive.pipe(Layer.provide(DomainCluster.layerSharding({ name: "Apart" }))),
            ),
            Effect.provide(singleRunner(url)),
          );
          expect(apart).toEqual({ total: 4 });
        }),
      { timeout: 60_000 },
    );
  },
);
