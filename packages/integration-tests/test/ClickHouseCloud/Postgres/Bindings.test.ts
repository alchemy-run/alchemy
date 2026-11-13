import * as ClickHouseCloud from "@alchemy.run/clickhouse-cloud";
import * as Cloudflare from "@alchemy.run/cloudflare";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import pg from "pg";
import { bindingTags as tags, getJson, noCloudflare } from "../fixtures/bindings.ts";
import ClickHousePostgresWorker from "../fixtures/postgres-worker.ts";
import { BindingsDb } from "../fixtures/resources.ts";

// Deploys a Postgres service (billed while it runs), so it also needs
// CLICKHOUSE_CLOUD_TEST_SLOW=1.
const skipped = noCloudflare || !process.env.CLICKHOUSE_CLOUD_TEST_SLOW;

const providers = Layer.mergeAll(ClickHouseCloud.providers(), Cloudflare.providers());
const { test, beforeAll, afterAll, deploy, destroy } = Test.make({ providers });

const Stack = Alchemy.Stack(
  "ClickHouseCloudPostgresBindings",
  // Local state: the shared Cloudflare state store of the test account is
  // on an older schema, and upgrading it is the account owner's call.
  { providers, state: Alchemy.localState() },
  Effect.gen(function* () {
    const db = yield* BindingsDb;
    const worker = yield* ClickHousePostgresWorker;
    return { url: worker.url.as<string>(), postgresId: db.postgresId, hostname: db.hostname };
  }),
);

const stack = beforeAll(
  skipped ? Effect.succeed({ url: "", postgresId: "", hostname: "" }) : deploy(Stack),
  { timeout: 3_600_000 },
);
afterAll.skipIf(skipped || !!process.env.NO_DESTROY)(destroy(Stack), { timeout: 3_600_000 });

const get = getJson(stack);

interface Connection {
  hostname: string;
  username: string;
  connectionString: string;
  caCertificates: string;
}

/** Run SQL from the test runner with what Connect handed the Worker. */
const query = (conn: Connection, sql: string) =>
  Effect.promise(async () => {
    // The URL carries sslmode=verify-full, which would override `ssl`, so
    // its parts are passed with the CA instead.
    const url = new URL(conn.connectionString);
    const client = new pg.Client({
      host: url.hostname,
      port: Number(url.port || 5432),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      database: url.pathname.slice(1) || "postgres",
      ssl: { ca: conn.caCertificates, rejectUnauthorized: true },
    });
    await client.connect();
    try {
      return (await client.query(sql)).rows;
    } finally {
      await client.end();
    }
  });

const until = <A>(path: string, done: (a: A) => boolean, duration = "10 minutes") =>
  get<A>(path).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("15 seconds").pipe(
        Schedule.upTo({ duration: duration as "10 minutes" }),
      ),
      until: done,
    }),
  );

// The restart test is last: it takes the service down for a minute.
describe.skipIf(skipped).sequential("ClickHouseCloud Postgres bindings", () => {
  test(
    "Connect hands the host credentials that connect over verified TLS",
    Effect.gen(function* () {
      const { hostname } = yield* stack;
      const conn = yield* get<Connection>("/connection");
      expect(conn.hostname).toEqual(hostname);
      expect(conn.connectionString).toContain(`@${hostname}`);
      expect(yield* query(conn, "select 1 as ok")).toEqual([{ ok: 1 }]);
    }),
    { tags, timeout: 120_000 },
  );

  test(
    "GetPostgresService reads the bound service, running",
    Effect.gen(function* () {
      const { postgresId } = yield* stack;
      expect(yield* get<{ id: string; state: string }>("/service")).toEqual({
        id: postgresId,
        state: "running",
      });
    }),
    { tags, timeout: 120_000 },
  );

  test(
    "GetPostgresServiceMetrics returns the last hour's series",
    Effect.gen(function* () {
      const { keys } = yield* get<{ keys: string[] }>("/metrics");
      expect(keys.length).toBeGreaterThan(0);
    }),
    { tags, timeout: 120_000 },
  );

  test(
    "ListPostgresLogs returns the last hour's log lines",
    Effect.gen(function* () {
      // A fresh server has logged its start-up.
      const { count } = yield* until<{ count: number }>("/logs", (b) => b.count > 0);
      expect(count).toBeGreaterThan(0);
    }),
    { tags, timeout: 900_000 },
  );

  test(
    "ListPostgresSlowQueryPatterns and GetPostgresSlowQueryPattern find a slow query",
    Effect.gen(function* () {
      const conn = yield* get<Connection>("/connection");
      for (let i = 0; i < 3; i++) yield* query(conn, "select pg_sleep(2)");
      const found = yield* until<{ queryId: string | null; detailQueryId: string | null }>(
        "/slow-queries",
        (b) => b.queryId !== null,
      );
      expect(found.queryId).not.toBeNull();
      expect(found.detailQueryId).toEqual(found.queryId);
    }),
    { tags, timeout: 900_000 },
  );

  test(
    "ListPostgresServiceBackups lists the service's backups",
    Effect.gen(function* () {
      const { statuses } = yield* get<{ statuses: string[] }>("/backups");
      expect(Array.isArray(statuses)).toBe(true);
    }),
    { tags, timeout: 120_000 },
  );

  test(
    "GetPostgresServicePrometheusMetrics scrapes the Prometheus text format",
    Effect.gen(function* () {
      const { text } = yield* get<{ text: string }>("/prometheus");
      expect(text).toContain("# TYPE");
    }),
    { tags, timeout: 120_000 },
  );

  test(
    "UpdatePostgresServiceState restarts the service, which comes back running",
    Effect.gen(function* () {
      const { postgresId } = yield* stack;
      expect((yield* get<{ id: string }>("/state")).id).toEqual(postgresId);
      const back = yield* until<{ id: string; state: string }>(
        "/service",
        (s) => s.state === "running",
      );
      expect(back.state).toEqual("running");
    }),
    { tags, timeout: 900_000 },
  );
});
