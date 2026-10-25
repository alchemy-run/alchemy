import { expect } from "bun:test";
import * as Azure from "@alchemy.run/azure";
import * as app from "@distilled.cloud/azure/app";
import * as authorization from "@distilled.cloud/azure/authorization";
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

// A Consumption environment (free while idle), one 0.25 vCPU app that scales
// to zero, a Basic container registry, and a Standard LRS storage account:
// a few cents per run. The environment takes 3-6 minutes to create and up to
// ~25 minutes to delete.
const stack = beforeAll(deploy(Stack), { timeout: 2_400_000 });

class NotOk extends Data.TaggedError("NotOk")<{ readonly status: number; readonly body: string }> {}

/** Call the API; retry until it answers `expected`. */
const call = (method: "GET" | "PUT", path: string, expected: number, body?: string) =>
  Effect.gen(function* () {
    const { url } = yield* stack;
    const client = yield* HttpClient.HttpClient;
    const target = `${String(url).replace(/\/+$/, "")}${path}`;
    const request =
      method === "PUT"
        ? HttpClientRequest.put(target).pipe(HttpClientRequest.bodyText(body ?? ""))
        : HttpClientRequest.get(target);
    const res = yield* client.execute(request).pipe(
      // A request to an app scaled to zero waits for a replica: bound it.
      Effect.timeout("20 seconds"),
      Effect.mapError((error) => new NotOk({ status: 0, body: String(error) })),
    );
    const text = yield* res.text.pipe(
      Effect.mapError((error) => new NotOk({ status: res.status, body: String(error) })),
    );
    if (res.status !== expected) return yield* new NotOk({ status: res.status, body: text });
    return text;
  }).pipe(
    // The first revision's cold start, and the blob role propagating after
    // the first deploy, take a few minutes.
    // At most ~10 minutes.
    Effect.retry({ schedule: Schedule.spaced("10 seconds"), times: 20 }),
  );

/** Where the example's resources are, from the stack outputs. */
const where = Effect.gen(function* () {
  const outputs = yield* stack;
  const { subscriptionId } = yield* Azure.AzureEnvironment.current.pipe(Effect.provide(azure));
  return { subscriptionId, ...outputs };
});

type Where = Effect.Success<typeof where>;

const getApp = (ids: Where) =>
  app
    .GetContainerApp({
      subscriptionId: ids.subscriptionId,
      resourceGroupName: ids.resourceGroup,
      containerAppName: ids.appName,
    })
    .pipe(Effect.provide(azure));

const gone = () => Effect.succeed("gone" as const);

const appStatus = (ids: Where) =>
  getApp(ids).pipe(
    Effect.as("found" as const),
    Effect.catchTag(["ResourceNotFound", "ResourceGroupNotFound"], gone),
  );

const environmentStatus = (ids: Where) =>
  app
    .GetManagedEnvironment({
      subscriptionId: ids.subscriptionId,
      resourceGroupName: ids.resourceGroup,
      environmentName: ids.environmentName,
    })
    .pipe(
      Effect.as("found" as const),
      Effect.catchTag(["ResourceNotFound", "ResourceGroupNotFound"], gone),
      Effect.provide(azure),
    );

/** Poll until a deleted resource reads as gone. */
const untilGone = <E, R>(current: Effect.Effect<"found" | "gone", E, R>) =>
  current.pipe(
    Effect.repeat({
      schedule: Schedule.spaced("10 seconds"),
      until: (s) => s === "gone",
      times: 30,
    }),
  );

afterAll.skipIf(!!process.env.NO_DESTROY)(
  Effect.gen(function* () {
    const ids = yield* where;
    yield* destroy(Stack);
    expect(yield* untilGone(appStatus(ids))).toBe("gone");
    expect(yield* untilGone(environmentStatus(ids))).toBe("gone");
  }),
  // Deleting a Workload Profiles environment takes up to ~25 minutes.
  { timeout: 2_400_000 },
);

test(
  "the app answers on its public URL",
  Effect.gen(function* () {
    expect(yield* call("GET", "/", 200)).toBe("ok");
  }),
  { timeout: 900_000 },
);

test(
  "a stored note reads back through the blob binding",
  Effect.gen(function* () {
    const key = crypto.randomUUID();
    const text = `hello from ${key}`;
    expect(yield* call("PUT", `/notes/${key}`, 201, text)).toBe("stored");
    expect(yield* call("GET", `/notes/${key}`, 200)).toBe(text);
  }),
  { timeout: 900_000 },
);

test(
  "an unknown note is 404",
  Effect.gen(function* () {
    expect(yield* call("GET", `/notes/${crypto.randomUUID()}`, 404)).toBe("not found");
  }),
  { timeout: 900_000 },
);

test(
  "the app runs with a system identity that holds Blob Data Contributor on the container",
  Effect.gen(function* () {
    const ids = yield* where;
    const observed = yield* getApp(ids);
    expect(observed.properties?.provisioningState).toBe("Succeeded");
    expect(observed.identity?.type).toBe("SystemAssigned");
    expect(observed.identity?.principalId).toBe(ids.principalId);
    expect(observed.properties?.template?.containers?.[0]?.image).toMatch(
      new RegExp(`^[a-z0-9]+\\.azurecr\\.io/${ids.appName}:[0-9a-f]+$`),
    );

    const page = yield* authorization
      .ListRoleAssignmentForSubscription({
        subscriptionId: ids.subscriptionId,
        _filter: `principalId eq '${ids.principalId}'`,
      })
      .pipe(Effect.provide(azure));
    const grants = page.value.map(
      (a) =>
        `${a.properties?.scope?.toLowerCase()}|${a.properties?.roleDefinitionId?.split("/").pop()}`,
    );
    expect(grants).toEqual([
      `${ids.containerId.toLowerCase()}|${Azure.Authorization.BuiltInRole.StorageBlobDataContributor}`,
    ]);
  }),
  { timeout: 120_000 },
);
