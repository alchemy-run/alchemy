import { expect } from "bun:test";
import * as Azure from "@alchemy.run/azure";
import * as redisenterprise from "@distilled.cloud/azure/redisenterprise";
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
import { LIMIT, WINDOW_SECONDS } from "../src/Api.ts";

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

// A Balanced_B0 cluster without high availability (about $0.02/hour) and a
// Flex Consumption app (billed per execution): a few cents per run. The
// cluster takes 5-10 minutes to create and about as long to delete.
const stack = beforeAll(deploy(Stack), { timeout: 1_800_000 });

class NotOk extends Data.TaggedError("NotOk")<{ readonly status: number; readonly body: string }> {}

interface Counter {
  key: string;
  count: number;
  limit: number;
  remaining: number;
  limited: boolean;
  resetInSeconds: number | null;
}

const baseUrl = Effect.map(stack, ({ url }) => String(url).replace(/\/+$/, ""));

/** Where the example's resources are, from the stack outputs. */
const where = Effect.gen(function* () {
  const outputs = yield* stack;
  const { subscriptionId } = yield* Azure.AzureEnvironment.current.pipe(Effect.provide(azure));
  return { subscriptionId, resourceGroupName: outputs.resourceGroup, outputs };
});

type Where = Effect.Success<typeof where>;

/**
 * Wait until the app answers *and* can sign in to Redis. `/count` answers
 * 503 through the Flex Consumption cold start and until the access policy
 * assignment takes effect.
 */
const ready = Effect.flatMap(baseUrl, (base) =>
  Effect.gen(function* () {
    const res = yield* HttpClient.execute(HttpClientRequest.get(`${base}/count/warmup`));
    const body = yield* res.text;
    if (res.status !== 200) return yield* new NotOk({ status: res.status, body });
    return JSON.parse(body) as Counter;
  }).pipe(
    Effect.tapError((error) => Effect.logWarning(error)),
    Effect.retry({ schedule: Schedule.spaced("10 seconds"), times: 48 }),
  ),
);

const hit = (key: string) =>
  Effect.flatMap(baseUrl, (base) =>
    Effect.gen(function* () {
      const res = yield* HttpClient.execute(HttpClientRequest.post(`${base}/hit/${key}`));
      const text = yield* res.text;
      const body = JSON.parse(text) as Counter;
      return { status: res.status, retryAfter: res.headers["retry-after"], body };
    }),
  );

const count = (key: string) =>
  Effect.flatMap(baseUrl, (base) =>
    HttpClient.execute(HttpClientRequest.get(`${base}/count/${key}`)).pipe(
      Effect.flatMap((res) => res.text),
      Effect.map((text) => JSON.parse(text) as Counter),
    ),
  );

const clusterStatus = ({ subscriptionId, resourceGroupName, outputs }: Where) =>
  redisenterprise
    .GetRedisEnterprise({ subscriptionId, resourceGroupName, clusterName: outputs.clusterName })
    .pipe(
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
      schedule: Schedule.spaced("10 seconds"),
      until: (current) => current === "gone",
      times: 30,
    }),
  );

afterAll.skipIf(!!process.env.NO_DESTROY)(
  Effect.gen(function* () {
    const deployed = yield* stack;
    yield* destroy(Stack);
    // A failed deploy has no outputs to check against.
    if (deployed === undefined) return;
    const ids = yield* where;
    expect(yield* untilGone(clusterStatus(ids))).toBe("gone");
    expect(yield* untilGone(appStatus(ids))).toBe("gone");
  }),
  { timeout: 1_200_000 },
);

test(
  "provisions a Balanced_B0 cluster with an Entra-only EnterpriseCluster database",
  Effect.gen(function* () {
    const { subscriptionId, resourceGroupName, outputs } = yield* where;
    const clusterRef = { subscriptionId, resourceGroupName, clusterName: outputs.clusterName };

    const cluster = yield* redisenterprise
      .GetRedisEnterprise(clusterRef)
      .pipe(Effect.provide(azure));
    expect(cluster.sku?.name).toBe("Balanced_B0");
    expect(cluster.properties?.highAvailability).toBe("Disabled");
    expect(cluster.properties?.resourceState).toBe("Running");
    expect(cluster.properties?.hostName).toBe(outputs.hostName);

    const database = yield* redisenterprise
      .GetDatabase({ ...clusterRef, databaseName: outputs.databaseName })
      .pipe(Effect.provide(azure));
    expect(database.properties?.clusteringPolicy).toBe("EnterpriseCluster");
    expect(database.properties?.clientProtocol).toBe("Encrypted");
    expect(database.properties?.accessKeysAuthentication).toBe("Disabled");
    expect(database.properties?.port).toBe(outputs.port);

    // The app's managed identity holds the database's `default` access policy.
    const assignment = yield* redisenterprise
      .GetAccessPolicyAssignment({
        ...clusterRef,
        databaseName: outputs.databaseName,
        accessPolicyAssignmentName: outputs.accessPolicyAssignmentName,
      })
      .pipe(Effect.provide(azure));
    expect(assignment.properties?.accessPolicyName).toBe("default");
    expect(assignment.properties?.user?.objectId).toBe(outputs.principalId);
  }),
  { timeout: 120_000 },
);

test(
  "counts hits, sets the window TTL, and enforces the limit",
  Effect.gen(function* () {
    const warm = yield* ready;
    expect(warm).toMatchObject({ key: "warmup", limit: LIMIT });

    const key = `integ-${crypto.randomUUID()}`;

    const fresh = yield* count(key);
    expect(fresh).toMatchObject({ key, count: 0, remaining: LIMIT, resetInSeconds: null });

    for (let n = 1; n <= LIMIT; n++) {
      const { status, body } = yield* hit(key);
      expect(status).toBe(200);
      expect(body).toMatchObject({
        key,
        count: n,
        limit: LIMIT,
        remaining: LIMIT - n,
        limited: false,
      });
      expect(body.resetInSeconds).toBeGreaterThan(0);
      expect(body.resetInSeconds).toBeLessThanOrEqual(WINDOW_SECONDS);
    }

    const over = yield* hit(key);
    expect(over.status).toBe(429);
    expect(Number(over.retryAfter)).toBeGreaterThan(0);
    expect(over.body).toMatchObject({ count: LIMIT + 1, remaining: 0, limited: true });

    // The window's TTL is set once, on the first hit, and ticks down.
    const after = yield* count(key);
    expect(after.count).toBe(LIMIT + 1);
    expect(after.resetInSeconds).toBeGreaterThan(0);
    expect(after.resetInSeconds).toBeLessThanOrEqual(WINDOW_SECONDS);

    // Keys count independently.
    const other = yield* hit(`${key}-other`);
    expect(other.status).toBe(200);
    expect(other.body.count).toBe(1);
  }),
  { timeout: 900_000 },
);

test(
  "rejects malformed keys and unknown routes",
  Effect.gen(function* () {
    yield* ready;
    const base = yield* baseUrl;
    const bad = yield* HttpClient.execute(HttpClientRequest.post(`${base}/hit/no%20spaces`));
    expect(bad.status).toBe(404);
    const unknown = yield* HttpClient.execute(HttpClientRequest.get(`${base}/hit/abc`));
    expect(unknown.status).toBe(404);
  }),
  { timeout: 900_000 },
);
