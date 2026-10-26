import { expect } from "bun:test";
import * as Azure from "@alchemy.run/azure";
import * as sql from "@distilled.cloud/azure/sql";
import * as web from "@distilled.cloud/azure/web";
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
import * as Schedule from "effect/Schedule";
import Stack, { providers } from "../alchemy.run.ts";
import type { Todo } from "../src/Api.ts";
import { SQL_LOCATION } from "../src/resources.ts";

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

// A Basic (5 DTU) database bills about $0.007 per hour; the logical server
// is free; the Flex Consumption app and its storage cost under a cent.
// One run (about 10 minutes) costs a few cents, so the test is not gated.
const stack = beforeAll(deploy(Stack), { timeout: 1_200_000 });

class NotOk extends Data.TaggedError("NotOk")<{ readonly status: number; readonly body: string }> {}

const baseUrl = Effect.map(stack, ({ url }) => String(url).replace(/\/+$/, ""));

/**
 * Call the API and expect `expected`. Retries through the Flex Consumption
 * cold start and the firewall rule taking effect after the first deploy
 * (the API answers 503 with the SQL error until then).
 */
const call = <T>(request: HttpClientRequest.HttpClientRequest, expected: number) =>
  Effect.gen(function* () {
    const res = yield* HttpClient.execute(request);
    const body = yield* res.text;
    if (res.status !== expected) return yield* new NotOk({ status: res.status, body });
    return (body === "" ? undefined : JSON.parse(body)) as T;
  }).pipe(
    Effect.tapError((error) => Effect.logWarning(error)),
    Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 36 }),
  );

const get = <T>(path: string, expected = 200) =>
  Effect.flatMap(baseUrl, (base) => call<T>(HttpClientRequest.get(`${base}${path}`), expected));

const send = <T>(
  method: "POST" | "PATCH" | "DELETE",
  path: string,
  body: unknown,
  expected: number,
) =>
  Effect.flatMap(baseUrl, (base) => {
    const request = HttpClientRequest.make(method)(`${base}${path}`);
    return call<T>(
      body === undefined ? request : request.pipe(HttpClientRequest.bodyJsonUnsafe(body)),
      expected,
    );
  });

/** Where the example's resources are, from the stack outputs. */
const where = Effect.gen(function* () {
  const outputs = yield* stack;
  const { subscriptionId } = yield* Azure.AzureEnvironment.current.pipe(Effect.provide(azure));
  return { subscriptionId, resourceGroupName: outputs.resourceGroup, outputs };
});

type Where = Effect.Success<typeof where>;

const serverStatus = ({ subscriptionId, resourceGroupName, outputs }: Where) =>
  sql.GetServer({ subscriptionId, resourceGroupName, serverName: outputs.serverName }).pipe(
    Effect.as("found" as const),
    Effect.catchTag(["ResourceNotFound", "ResourceGroupNotFound"], () =>
      Effect.succeed("gone" as const),
    ),
    Effect.provide(azure),
  );

const appStatus = ({ subscriptionId, resourceGroupName, outputs }: Where) =>
  web.GetWebApp({ subscriptionId, resourceGroupName, name: outputs.functionAppName }).pipe(
    Effect.as("found" as const),
    Effect.catchTag(["ResourceNotFound", "ResourceGroupNotFound"], () =>
      Effect.succeed("gone" as const),
    ),
    Effect.provide(azure),
  );

/** Poll until a deleted resource reads as gone. */
const untilGone = <E, R>(status: Effect.Effect<"found" | "gone", E, R>) =>
  status.pipe(
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (current) => current === "gone",
      times: 24,
    }),
  );

afterAll.skipIf(!!process.env.NO_DESTROY)(
  Effect.gen(function* () {
    const deployed = yield* stack;
    yield* destroy(Stack);
    // A failed deploy has no outputs to check against.
    if (deployed === undefined) return;
    const ids = yield* where;
    expect(yield* untilGone(serverStatus(ids))).toBe("gone");
    expect(yield* untilGone(appStatus(ids))).toBe("gone");
  }),
  { timeout: 900_000 },
);

test(
  "the server, database, and firewall rule exist as declared",
  Effect.gen(function* () {
    const { subscriptionId, resourceGroupName, outputs } = yield* where;
    const server = yield* sql
      .GetServer({ subscriptionId, resourceGroupName, serverName: outputs.serverName })
      .pipe(Effect.provide(azure));
    expect(server.location.replace(/\s+/g, "").toLowerCase()).toBe(SQL_LOCATION);
    expect(server.properties?.state).toBe("Ready");

    const database = yield* sql
      .GetDatabase({
        subscriptionId,
        resourceGroupName,
        serverName: outputs.serverName,
        databaseName: outputs.databaseName,
      })
      .pipe(Effect.provide(azure));
    expect(database.sku?.name).toBe("Basic");
    expect(database.properties?.status).toBe("Online");

    const rule = yield* sql
      .GetFirewallRule({
        subscriptionId,
        resourceGroupName,
        serverName: outputs.serverName,
        firewallRuleName: outputs.firewallRuleName,
      })
      .pipe(Effect.provide(azure));
    expect(rule.properties?.startIpAddress).toBe("0.0.0.0");
    expect(rule.properties?.endIpAddress).toBe("0.0.0.0");
  }),
  { timeout: 120_000 },
);

test(
  "the first request applies the migrations",
  Effect.gen(function* () {
    const migrations = yield* get<{ id: number; name: string }[]>("/migrations");
    expect(migrations).toEqual([
      { id: 1, name: "create_todos" },
      { id: 2, name: "index_todos_created_at" },
    ]);
  }),
  { timeout: 300_000 },
);

test(
  "creates, reads, updates, and deletes a todo",
  Effect.gen(function* () {
    const created = yield* send<Todo>("POST", "/todos", { title: "write the example" }, 201);
    expect(created.title).toBe("write the example");
    expect(created.done).toBe(false);
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/);

    const listed = yield* get<Todo[]>("/todos");
    expect(listed.map((todo) => todo.id)).toContain(created.id);

    const updated = yield* send<Todo>("PATCH", `/todos/${created.id}`, { done: true }, 200);
    expect(updated).toEqual({ ...created, done: true });

    const read = yield* get<Todo>(`/todos/${created.id}`);
    expect(read.done).toBe(true);

    yield* send<undefined>("DELETE", `/todos/${created.id}`, undefined, 204);
    const missing = yield* get<{ error: string }>(`/todos/${created.id}`, 404);
    expect(missing.error).toBe("not found");
  }),
  { timeout: 300_000 },
);

test(
  "rejects a todo without a title",
  Effect.gen(function* () {
    const res = yield* send<{ error: string }>("POST", "/todos", { title: "" }, 400);
    expect(res.error.length).toBeGreaterThan(0);
  }),
  { timeout: 300_000 },
);
