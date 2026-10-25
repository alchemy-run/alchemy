import { expect } from "bun:test";
import * as Azure from "@alchemy.run/azure";
import * as servicebus from "@distilled.cloud/azure/servicebus";
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

// A Standard Service Bus namespace (billed hourly, about $0.0135/hour), two
// Flex Consumption apps (billed per execution) and three storage accounts:
// a few cents per run.
const stack = beforeAll(deploy(Stack), { timeout: 1_200_000 });

class NotOk extends Data.TaggedError("NotOk")<{ readonly status: number; readonly body: string }> {}

interface Accepted {
  id: string;
  status: "pending";
}

interface ResultBody {
  id: string;
  status?: "pending";
  item?: string;
  quantity?: number;
  deliveryCount?: number;
  type?: string;
  messageId?: string;
}

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

const post = (path: string, body: unknown) =>
  Effect.flatMap(baseUrl, (base) =>
    call<Accepted>(
      HttpClientRequest.post(`${base}${path}`).pipe(HttpClientRequest.bodyJsonUnsafe(body)),
      202,
    ),
  );

/** Poll a result until the worker has written it. */
const resultOf = (kind: "orders" | "audit" | "notify", id: string) =>
  Effect.flatMap(baseUrl, (base) =>
    Effect.gen(function* () {
      const res = yield* HttpClient.execute(HttpClientRequest.get(`${base}/results/${kind}/${id}`));
      const body = yield* res.text;
      if (res.status !== 200 && res.status !== 202) {
        return yield* new NotOk({ status: res.status, body });
      }
      return JSON.parse(body) as ResultBody;
    }).pipe(
      Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 24 }),
      // The worker's first trigger run, and its Service Bus receive role,
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

/** Active and dead-lettered message counts, read through ARM until both drain to 0. */
const drained = <E, R>(
  read: Effect.Effect<{ properties?: { countDetails?: servicebus.MessageCountDetails } }, E, R>,
) =>
  read.pipe(
    Effect.map(({ properties }) => ({
      active: properties?.countDetails?.activeMessageCount,
      deadLetter: properties?.countDetails?.deadLetterMessageCount,
    })),
    // ARM's message counts trail the data plane by up to a minute.
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (counts) => counts.active === 0,
      times: 24,
    }),
    Effect.provide(azure),
  );

type Where = Effect.Success<typeof where>;

const namespaceStatus = ({ subscriptionId, resourceGroupName, outputs }: Where) =>
  servicebus
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
  "rejects an order without an item",
  Effect.gen(function* () {
    const base = yield* baseUrl;
    const res = yield* call<{ error: string }>(
      HttpClientRequest.post(`${base}/orders`).pipe(
        HttpClientRequest.bodyJsonUnsafe({ quantity: 1 }),
      ),
      400,
    );
    expect(res.error).toBe("expected { item: string, quantity: number }");
  }),
  { timeout: 300_000 },
);

test(
  "an order goes through the queue to the worker",
  Effect.gen(function* () {
    const { subscriptionId, resourceGroupName, outputs } = yield* where;
    const { id } = yield* post("/orders", { item: "widget", quantity: 3 });

    const result = yield* resultOf("orders", id);
    expect(result).toMatchObject({ id, item: "widget", quantity: 3 });
    expect(result.deliveryCount).toBeGreaterThanOrEqual(1);

    // The worker completed the message: nothing is left on the queue, and
    // nothing was dead-lettered.
    const counts = yield* drained(
      servicebus.GetQueue({
        subscriptionId,
        resourceGroupName,
        namespaceName: outputs.namespaceName,
        queueName: outputs.queueName,
      }),
    );
    expect(counts).toEqual({ active: 0, deadLetter: 0 });
  }),
  { timeout: 900_000 },
);

test(
  "an event fans out to both topic subscriptions",
  Effect.gen(function* () {
    const { subscriptionId, resourceGroupName, outputs } = yield* where;
    const { id } = yield* post("/events", { type: "order.shipped" });

    const audit = yield* resultOf("audit", id);
    expect(audit).toMatchObject({ id, type: "order.shipped", messageId: id });
    const notify = yield* resultOf("notify", id);
    expect(notify).toMatchObject({ id, type: "order.shipped" });

    for (const subscriptionName of outputs.subscriptionNames) {
      const counts = yield* drained(
        servicebus.GetSubscription({
          subscriptionId,
          resourceGroupName,
          namespaceName: outputs.namespaceName,
          topicName: outputs.topicName,
          subscriptionName,
        }),
      );
      expect(counts).toEqual({ active: 0, deadLetter: 0 });
    }
  }),
  { timeout: 900_000 },
);
