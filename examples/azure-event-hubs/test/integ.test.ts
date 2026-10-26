import { expect } from "bun:test";
import * as Azure from "@alchemy.run/azure";
import * as eventhub from "@distilled.cloud/azure/eventhub";
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
import type { ReadingResult } from "../src/resources.ts";

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

// A Standard Event Hubs namespace with one throughput unit (billed hourly,
// about $0.03/hour), two Flex Consumption apps (billed per execution) and
// three storage accounts: a few cents per run.
const stack = beforeAll(deploy(Stack), { timeout: 1_200_000 });

class NotOk extends Data.TaggedError("NotOk")<{ readonly status: number; readonly body: string }> {}

interface Accepted {
  ids: string[];
  status: "pending";
}

type ResultBody = Partial<ReadingResult> & { id: string; status?: "pending" };

const baseUrl = Effect.map(stack, ({ url }) => String(url).replace(/\/+$/, ""));

/**
 * Call the API. Retries through the Flex Consumption cold start and the
 * app's role assignments propagating after the first deploy (the API
 * answers 503 until then).
 */
const call = <T>(request: HttpClientRequest.HttpClientRequest, expected: number) =>
  Effect.gen(function* () {
    const res = yield* HttpClient.execute(request);
    const body = yield* res.text;
    if (res.status !== expected) return yield* new NotOk({ status: res.status, body });
    return JSON.parse(body) as T;
  }).pipe(
    Effect.tapError((error) => Effect.logWarning(error)),
    Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 48 }),
  );

const sendReadings = (deviceId: string, body: unknown) =>
  Effect.flatMap(baseUrl, (base) =>
    call<Accepted>(
      HttpClientRequest.post(`${base}/devices/${deviceId}/readings`).pipe(
        HttpClientRequest.bodyJsonUnsafe(body),
      ),
      202,
    ),
  );

/** Poll a reading's result until the worker has written it. */
const resultOf = (id: string) =>
  Effect.flatMap(baseUrl, (base) =>
    Effect.gen(function* () {
      const res = yield* HttpClient.execute(HttpClientRequest.get(`${base}/readings/${id}`));
      const body = yield* res.text;
      if (res.status !== 200 && res.status !== 202) {
        return yield* new NotOk({ status: res.status, body });
      }
      return JSON.parse(body) as ResultBody;
    }).pipe(
      Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 24 }),
      // The worker's first trigger run, and its Event Hubs receive role,
      // can take a few minutes after a fresh deploy.
      Effect.repeat({
        schedule: Schedule.spaced("10 seconds"),
        until: (result) => result.status !== "pending",
        times: 48,
      }),
    ),
  );

/** Where the example's resources are, from the stack outputs. */
const where = Effect.gen(function* () {
  const outputs = yield* stack;
  const { subscriptionId } = yield* Azure.AzureEnvironment.current.pipe(Effect.provide(azure));
  return { subscriptionId, resourceGroupName: outputs.resourceGroup, outputs };
});

type Where = Effect.Success<typeof where>;

/** The event hub as ARM reports it. */
const readEventHub = ({ subscriptionId, resourceGroupName, outputs }: Where) =>
  eventhub
    .GetEventHub({
      subscriptionId,
      resourceGroupName,
      namespaceName: outputs.namespaceName,
      eventHubName: outputs.eventHubName,
    })
    .pipe(Effect.provide(azure));

const namespaceStatus = ({ subscriptionId, resourceGroupName, outputs }: Where) =>
  eventhub
    .GetNamespace({ subscriptionId, resourceGroupName, namespaceName: outputs.namespaceName })
    .pipe(
      Effect.as("found" as const),
      Effect.catchTag(["ResourceNotFound", "ResourceGroupNotFound"], () =>
        Effect.succeed("gone" as const),
      ),
      Effect.provide(azure),
    );

const appStatus = ({ subscriptionId, resourceGroupName }: Where, name: string) =>
  web.GetWebApp({ subscriptionId, resourceGroupName, name }).pipe(
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
    expect(yield* untilGone(namespaceStatus(ids))).toBe("gone");
    expect(yield* untilGone(appStatus(ids, ids.outputs.apiApp))).toBe("gone");
    expect(yield* untilGone(appStatus(ids, ids.outputs.workerApp))).toBe("gone");
  }),
  { timeout: 900_000 },
);

test(
  "the event hub has two active partitions",
  Effect.gen(function* () {
    const hub = yield* readEventHub(yield* where);
    expect({
      partitionCount: hub.properties?.partitionCount,
      partitionIds: hub.properties?.partitionIds,
      status: hub.properties?.status,
      messageRetentionInDays: hub.properties?.messageRetentionInDays,
    }).toEqual({
      partitionCount: 2,
      partitionIds: ["0", "1"],
      status: "Active",
      messageRetentionInDays: 1,
    });
  }),
  { timeout: 300_000 },
);

test(
  "rejects a reading without a temperature",
  Effect.gen(function* () {
    const base = yield* baseUrl;
    const res = yield* call<{ error: string }>(
      HttpClientRequest.post(`${base}/devices/thermostat-0/readings`).pipe(
        HttpClientRequest.bodyJsonUnsafe({ humidity: 40 }),
      ),
      400,
    );
    expect(res.error).toBe("expected { temperature: number } or { temperatures: number[] }");
  }),
  { timeout: 300_000 },
);

test(
  "a single reading goes through the event hub to the worker",
  Effect.gen(function* () {
    const { ids } = yield* sendReadings("thermostat-1", { temperature: 21.5 });
    expect(ids).toHaveLength(1);

    const result = yield* resultOf(ids[0]!);
    expect(result).toMatchObject({ id: ids[0], deviceId: "thermostat-1", temperature: 21.5 });
    expect(result.partitionId).toMatch(/^[01]$/);
    expect(result.sequenceNumber).toBeGreaterThanOrEqual(0);
    expect(Number.isNaN(Date.parse(result.enqueuedTimeUtc!))).toBe(false);
  }),
  { timeout: 900_000 },
);

test(
  "a batch from one device lands in one partition, in send order",
  Effect.gen(function* () {
    const temperatures = [20, 20.5, 21];
    const { ids } = yield* sendReadings("thermostat-2", { temperatures });
    expect(ids).toHaveLength(3);

    const results: ResultBody[] = [];
    for (const id of ids) results.push(yield* resultOf(id));

    expect(results.map(({ deviceId, temperature }) => ({ deviceId, temperature }))).toEqual(
      temperatures.map((temperature) => ({ deviceId: "thermostat-2", temperature })),
    );
    // The partition key routes the whole batch to one partition.
    const partitions = new Set(results.map((r) => r.partitionId));
    expect(partitions.size).toBe(1);
    expect(results[0]!.partitionId).toMatch(/^[01]$/);
    // Within a partition, sequence numbers follow the send order.
    const sequence = results.map((r) => r.sequenceNumber!);
    expect(sequence).toEqual([...sequence].sort((a, b) => a - b));
    expect(new Set(sequence).size).toBe(3);
  }),
  { timeout: 900_000 },
);
