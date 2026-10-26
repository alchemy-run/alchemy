import { expect } from "bun:test";
import * as Azure from "@alchemy.run/azure";
import type { AzureOpError } from "@distilled.cloud/azure";
import * as cosmos from "@distilled.cloud/azure/cosmos_db";
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
import Stack from "../alchemy.run.ts";
import type { Change, Todo } from "../src/resources.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Azure.providers(),
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

// A serverless Cosmos DB account (billed per request unit, nothing idle)
// and two Flex Consumption apps (billed per execution): a few cents per run.
const stack = beforeAll(deploy(Stack), { timeout: 1_200_000 });

class Unexpected extends Data.TaggedError("Unexpected")<{
  readonly status: number;
  readonly body: string;
}> {}

interface TodoBody {
  todo: Todo;
  etag: string;
}

const baseUrl = Effect.map(stack, ({ url }) => String(url).replace(/\/+$/, ""));

/**
 * Send a request until it answers `expected`. The API answers 503 through
 * the Flex Consumption cold start and until the app's Cosmos DB data roles
 * apply (about 6 minutes after the first deploy).
 */
const call = <T>(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  expected: number,
  options: { body?: unknown; ifMatch?: string } = {},
) =>
  Effect.gen(function* () {
    const base = yield* baseUrl;
    let request = HttpClientRequest.make(method)(`${base}${path}`);
    if (options.body !== undefined) {
      request = request.pipe(HttpClientRequest.bodyJsonUnsafe(options.body));
    }
    if (options.ifMatch !== undefined) {
      request = request.pipe(HttpClientRequest.setHeader("if-match", options.ifMatch));
    }
    const res = yield* HttpClient.execute(request);
    const body = yield* res.text;
    if (res.status !== expected) return yield* new Unexpected({ status: res.status, body });
    return (body === "" ? undefined : JSON.parse(body)) as T;
  }).pipe(
    Effect.tapError((error) => Effect.logWarning(error)),
    Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 96 }),
  );

/**
 * Poll the worker's record of a todo until `ready` holds. The change-feed
 * trigger starts once the worker's data role applies, a few minutes after
 * a fresh deploy.
 */
const changeOf = (owner: string, id: string, ready: (change: Change) => boolean) =>
  Effect.gen(function* () {
    const base = yield* baseUrl;
    const res = yield* HttpClient.execute(HttpClientRequest.get(`${base}/changes/${owner}/${id}`));
    const body = yield* res.text;
    if (res.status === 202) return undefined;
    if (res.status !== 200) return yield* new Unexpected({ status: res.status, body });
    return (JSON.parse(body) as { change: Change }).change;
  }).pipe(
    Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 24 }),
    Effect.repeat({
      schedule: Schedule.spaced("10 seconds"),
      until: (change) => change !== undefined && ready(change),
      times: 60,
    }),
  );

/** Where the example's resources are, from the stack outputs. */
const where = Effect.gen(function* () {
  const outputs = yield* stack;
  const { subscriptionId } = yield* Azure.AzureEnvironment.current.pipe(Effect.provide(azure));
  return {
    subscriptionId,
    resourceGroupName: outputs.resourceGroup,
    accountName: outputs.accountName,
    outputs,
  };
});

type Where = Effect.Success<typeof where>;

/** Scopes of a principal's Cosmos DB data-role assignments, relative to the account. */
const dataRoleScopes = (
  { subscriptionId, resourceGroupName, accountName }: Where,
  principalId: string,
) =>
  cosmos.ListSqlResourceSqlRoleAssignments({ subscriptionId, resourceGroupName, accountName }).pipe(
    Effect.map(({ value }) =>
      (value ?? [])
        .filter((assignment) => assignment.properties?.principalId === principalId)
        .map((assignment) => {
          const scope = (assignment.properties?.scope ?? "").toLowerCase();
          return scope.slice(scope.indexOf("/dbs/"));
        })
        .sort(),
    ),
    Effect.provide(azure),
  );

/** Poll an ARM read until it answers a typed not-found. */
const gone = <A, R>(read: Effect.Effect<A, AzureOpError, R>) =>
  read.pipe(
    Effect.as("found" as const),
    Effect.catchTag(["ResourceNotFound", "ResourceGroupNotFound"], () =>
      Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (status) => status === "gone",
      times: 24,
    }),
    Effect.provide(azure),
  );

afterAll.skipIf(!!process.env.NO_DESTROY)(
  Effect.gen(function* () {
    const deployed = yield* stack;
    yield* destroy(Stack);
    // A failed deploy has no outputs to check against.
    if (deployed === undefined) return;
    const { subscriptionId, resourceGroupName, accountName, outputs } = yield* where;
    expect(
      yield* gone(cosmos.GetDatabaseAccount({ subscriptionId, resourceGroupName, accountName })),
    ).toBe("gone");
    for (const name of [outputs.apiApp, outputs.workerApp]) {
      expect(yield* gone(web.GetWebApp({ subscriptionId, resourceGroupName, name }))).toBe("gone");
    }
  }),
  // Data-role deletes (~4 min) and the account delete (up to 15 min).
  { timeout: 1_500_000 },
);

test(
  "each binding assigns its data role on its own container",
  Effect.gen(function* () {
    const ids = yield* where;
    const { databaseName, containers, apiPrincipalId, workerPrincipalId } = ids.outputs;
    const db = `/dbs/${databaseName}`.toLowerCase();
    const coll = (name: string) => `${db}/colls/${name}`.toLowerCase();

    // SqlContainerReadWrite(Todos) and SqlContainerRead(Changes).
    expect(yield* dataRoleScopes(ids, apiPrincipalId!)).toEqual(
      [coll(containers.changes), coll(containers.todos)].sort(),
    );
    // The change feed reads Todos and writes Leases (one role on the
    // database), plus SqlContainerWrite(Changes).
    expect(yield* dataRoleScopes(ids, workerPrincipalId!)).toEqual(
      [db, coll(containers.changes)].sort(),
    );

    const todos = yield* cosmos
      .GetSqlResourceSqlContainer({
        subscriptionId: ids.subscriptionId,
        resourceGroupName: ids.resourceGroupName,
        accountName: ids.accountName,
        databaseName,
        containerName: containers.todos,
      })
      .pipe(Effect.provide(azure));
    expect(todos.properties?.resource?.partitionKey?.paths).toEqual(["/owner"]);
  }),
  { timeout: 120_000 },
);

test(
  "rejects a todo without a title",
  Effect.gen(function* () {
    const res = yield* call<{ error: string }>("POST", "/todos/crud", 400, { body: {} });
    expect(res.error).toBe("expected { title: string }");
  }),
  { timeout: 600_000 },
);

test(
  "creates, reads, lists, updates and deletes a todo",
  Effect.gen(function* () {
    const created = yield* call<TodoBody>("POST", "/todos/crud", 201, {
      body: { title: "write the example" },
    });
    expect(created.todo).toMatchObject({ owner: "crud", title: "write the example", done: false });
    const { id } = created.todo;

    const read = yield* call<TodoBody>("GET", `/todos/crud/${id}`, 200);
    expect(read).toEqual(created);

    const listed = yield* call<{ todos: Todo[] }>("GET", "/todos/crud", 200);
    expect(listed.todos.map((todo) => todo.id)).toContain(id);

    const updated = yield* call<TodoBody>("PATCH", `/todos/crud/${id}`, 200, {
      body: { done: true },
      ifMatch: created.etag,
    });
    expect(updated.todo).toEqual({ ...created.todo, done: true });
    expect(updated.etag).not.toBe(created.etag);

    // The first etag is stale now: Cosmos DB refuses the write.
    const stale = yield* call<{ error: string }>("PATCH", `/todos/crud/${id}`, 412, {
      body: { title: "lost update" },
      ifMatch: created.etag,
    });
    expect(stale.error).toBe("the todo changed since that etag");

    yield* call("DELETE", `/todos/crud/${id}`, 204);
    yield* call("GET", `/todos/crud/${id}`, 404);
  }),
  { timeout: 900_000 },
);

test(
  "the worker records each change from the change feed",
  Effect.gen(function* () {
    const created = yield* call<TodoBody>("POST", "/todos/feed", 201, {
      body: { title: "watch the feed" },
    });
    const { id } = created.todo;

    const first = yield* changeOf("feed", id, () => true);
    expect(first).toMatchObject({ ...created.todo, version: created.etag });

    const updated = yield* call<TodoBody>("PATCH", `/todos/feed/${id}`, 200, {
      body: { done: true },
    });
    const second = yield* changeOf("feed", id, (change) => change.done);
    expect(second).toMatchObject({ ...updated.todo, version: updated.etag });
    expect(second!.changedAt).toBeGreaterThanOrEqual(first!.changedAt);
  }),
  { timeout: 1_200_000 },
);
