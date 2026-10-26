import { expect } from "bun:test";
import * as Azure from "@alchemy.run/azure";
import * as postgresql from "@distilled.cloud/azure/postgresql";
import * as web from "@distilled.cloud/azure/web";
import * as PgClient from "@effect/sql-pg/PgClient";
import * as Alchemy from "alchemy";
import { CredentialsStoreLive } from "alchemy/Auth/Credentials";
import { ProfileStoreLive } from "alchemy/Auth/Profile";
import * as Test from "alchemy/Test/Bun";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import Stack, { providers } from "../alchemy.run.ts";
import { APP_ROLE } from "../src/database.ts";
import { MIGRATIONS_TABLE } from "../src/migrate.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: providers(),
  state: Alchemy.localState(),
  profile: process.env.ALCHEMY_PROFILE,
});

/** The deployer's credentials, for out-of-band ARM reads. */
const azure = Layer.mergeAll(Azure.environmentFromAuthProvider(), Azure.fromAuthProvider()).pipe(
  Layer.provideMerge(Azure.AzureAuth),
  Layer.provideMerge(ProfileStoreLive),
  Layer.provideMerge(CredentialsStoreLive),
  Layer.provideMerge(FetchHttpClient.layer),
);

// A Burstable B1ms flexible server with 32 GiB (about $0.02/hour) and a
// Flex Consumption app (billed per execution): a few cents per run. The
// server takes 5-10 minutes to create and a few more to delete.
const stack = beforeAll(deploy(Stack), { timeout: 1_800_000 });

class NotOk extends Data.TaggedError("NotOk")<{ readonly status: number; readonly body: string }> {}

/** Where the example's resources are, from the stack outputs. */
const where = Effect.gen(function* () {
  const outputs = yield* stack;
  const { subscriptionId } = yield* Azure.AzureEnvironment.current.pipe(Effect.provide(azure));
  return { ...outputs, subscriptionId };
});

type Where = Effect.Success<typeof where>;

const serverRef = (ids: Where) => ({
  subscriptionId: ids.subscriptionId,
  resourceGroupName: ids.resourceGroup,
  serverName: ids.serverName,
});

/**
 * Query the app database directly as the server administrator. The stack's
 * `Deployer` firewall rule admits this machine.
 */
const query = (ids: Where, statement: string) =>
  Effect.gen(function* () {
    const admin = ids.adminConnectionString;
    if (admin === undefined) return yield* Effect.die("the server has no administrator password");
    const url = new URL(Redacted.value(admin));
    url.pathname = `/${ids.databaseName}`;
    return yield* Effect.gen(function* () {
      const sql = yield* PgClient.PgClient;
      const rows = yield* sql.unsafe<Record<string, unknown>>(statement);
      return [...rows];
    }).pipe(
      Effect.provide(
        PgClient.layer({
          url: Redacted.make(url.toString()),
          maxConnections: 1,
          connectTimeout: "15 seconds",
        }),
      ),
    );
  }).pipe(Effect.orDie);

/**
 * Call the API and expect `expected`. Retries through the Flex Consumption
 * cold start (the app answers 5xx or not at all until an instance runs).
 */
const call = (
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  expected: number,
  body?: unknown,
) =>
  Effect.gen(function* () {
    const { url } = yield* stack;
    const target = `${String(url).replace(/\/+$/, "")}${path}`;
    const request =
      body === undefined
        ? HttpClientRequest.make(method)(target)
        : HttpClientRequest.make(method)(target).pipe(HttpClientRequest.bodyJsonUnsafe(body));
    const res = yield* HttpClient.execute(request);
    const text = yield* res.text;
    if (res.status !== expected) return yield* new NotOk({ status: res.status, body: text });
    return text;
  }).pipe(
    Effect.tapError((error) => Effect.logWarning(error)),
    Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 36 }),
  );

const found = Effect.as("found" as const);
const gone = () => Effect.succeed("gone" as const);

/** Poll until a deleted resource reads as gone. */
const untilGone = <E, R>(status: Effect.Effect<"found" | "gone", E, R>) =>
  status.pipe(
    Effect.repeat({
      schedule: Schedule.spaced("10 seconds"),
      until: (current) => current === "gone",
      times: 30,
    }),
    Effect.provide(azure),
  );

afterAll.skipIf(!!process.env.NO_DESTROY)(
  Effect.gen(function* () {
    const ids = yield* where;
    yield* destroy(Stack);
    const server = postgresql
      .GetServer(serverRef(ids))
      .pipe(found, Effect.catchTag(["ResourceNotFound", "ResourceGroupNotFound"], gone));
    const serverStatus = yield* untilGone(server);
    expect(serverStatus).toBe("gone");
    const site = web
      .GetWebApp({
        subscriptionId: ids.subscriptionId,
        resourceGroupName: ids.resourceGroup,
        name: ids.functionAppName,
      })
      .pipe(found, Effect.catchTag(["ResourceNotFound", "ResourceGroupNotFound"], gone));
    const siteStatus = yield* untilGone(site);
    expect(siteStatus).toBe("gone");
  }),
  { timeout: 1_200_000 },
);

test(
  "deploys a burstable server, the app database, and two firewall rules",
  Effect.gen(function* () {
    const ids = yield* where;
    const server = yield* postgresql.GetServer(serverRef(ids)).pipe(Effect.provide(azure));
    expect(server.properties?.state).toBe("Ready");
    expect(server.sku?.name).toBe("Standard_B1ms");
    expect(server.properties?.version).toBe("17");
    expect(server.properties?.fullyQualifiedDomainName).toBe(ids.host);

    const db = yield* postgresql
      .GetDatabase({ ...serverRef(ids), databaseName: ids.databaseName })
      .pipe(Effect.provide(azure));
    expect(db.name).toBe("app");

    const rules = yield* postgresql
      .ListFirewallRuleByServer(serverRef(ids))
      .pipe(Effect.provide(azure));
    const ranges = rules.value
      .map((rule) => `${rule.properties.startIpAddress}-${rule.properties.endIpAddress}`)
      .sort();
    expect(ranges).toHaveLength(2);
    // Azure services, and this machine's single address.
    expect(ranges[0]).toBe("0.0.0.0-0.0.0.0");
    expect(ranges[1]).toMatch(/^(\d{1,3}(?:\.\d{1,3}){3})-\1$/);
  }),
  { timeout: 120_000 },
);

test(
  "applies the drizzle migration and grants the app role row access only",
  Effect.gen(function* () {
    const ids = yield* where;
    const applied = yield* query(ids, `SELECT name FROM ${MIGRATIONS_TABLE}`);
    expect(applied).toHaveLength(1);
    expect(String(applied[0]?.name)).toMatch(/^\d{14}_/);

    const columns = yield* query(
      ids,
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'todos' ORDER BY column_name",
    );
    expect(columns.map((row) => row.column_name)).toEqual(["done", "id", "title"]);

    const privileges = yield* query(
      ids,
      `SELECT has_table_privilege('${APP_ROLE}', 'todos', 'INSERT') AS can_insert,
        has_table_privilege('${APP_ROLE}', '${MIGRATIONS_TABLE}', 'SELECT') AS can_read_migrations,
        has_schema_privilege('${APP_ROLE}', 'public', 'CREATE') AS can_create`,
    );
    expect(privileges).toEqual([
      { can_insert: true, can_read_migrations: false, can_create: false },
    ]);
  }),
  { timeout: 120_000 },
);

test(
  "the app signs in as the app role over TLS",
  Effect.gen(function* () {
    const health = yield* call("GET", "/health", 200);
    expect(JSON.parse(health).rows).toEqual([{ username: APP_ROLE, tls: true }]);
  }),
  { timeout: 300_000 },
);

test(
  "serves CRUD over Drizzle, with the rows in PostgreSQL",
  Effect.gen(function* () {
    const ids = yield* where;
    const id = "aaaaaaaa-0000-4000-8000-000000000001";
    yield* call("DELETE", `/todos/${id}`, 204);

    const created = yield* call("POST", "/todos", 201, { id, title: "Ship the Azure guide" });
    expect(JSON.parse(created)).toEqual([{ id, title: "Ship the Azure guide", done: false }]);

    // The row is really in the database.
    const stored = yield* query(ids, `SELECT id, title, done FROM todos WHERE id = '${id}'`);
    expect(stored).toEqual([{ id, title: "Ship the Azure guide", done: false }]);

    const updated = yield* call("PATCH", `/todos/${id}`, 200, { done: true });
    expect(JSON.parse(updated)).toEqual({ id, title: "Ship the Azure guide", done: true });

    const listed = yield* call("GET", "/todos", 200);
    expect(JSON.parse(listed)).toEqual([{ id, title: "Ship the Azure guide", done: true }]);

    yield* call("POST", "/todos", 400, { id: "not-a-uuid", title: "" });

    yield* call("DELETE", `/todos/${id}`, 204);
    yield* call("GET", `/todos/${id}`, 404);
    const remaining = yield* query(ids, `SELECT id FROM todos WHERE id = '${id}'`);
    expect(remaining).toEqual([]);
  }),
  { timeout: 600_000 },
);
