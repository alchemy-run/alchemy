import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as TestCore from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import * as ai from "@distilled.cloud/cloudflare/ai";
import * as kv from "@distilled.cloud/cloudflare/kv";
import * as images from "@distilled.cloud/cloudflare/images";
import * as queues from "@distilled.cloud/cloudflare/queues";
import * as r2 from "@distilled.cloud/cloudflare/r2";
import * as vectorize from "@distilled.cloud/cloudflare/vectorize";
import * as workers from "@distilled.cloud/cloudflare/workers";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Cause from "effect/Cause";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Cloudflare.providers() });
type Kind = "images" | "kv" | "r2" | "vectorize" | "model" | "worker";
const createSource = (kind: Kind, id = "Source") =>
  Effect.gen(function* () {
    switch (kind) {
      case "images":
        return yield* Cloudflare.Images.Variant(id, {
          name: `alchemySubscription${id}`,
          fit: "contain",
          width: 100,
          height: 100,
        });
      case "kv":
        return yield* Cloudflare.KV.Namespace(id);
      case "r2":
        return yield* Cloudflare.R2.Bucket(id, { forceDestroy: true });
      case "vectorize":
        return yield* Cloudflare.Vectorize.Index(id, {
          dimensions: 32,
          metric: "cosine",
        });
      case "model":
        return yield* Cloudflare.AI.Model(id, {
          modelName: "@cf/baai/bge-m3",
        });
      case "worker":
        return yield* Cloudflare.Worker(id, {
          main: `${import.meta.dirname}/fixtures/subscription-source-worker.ts`,
        });
    }
  });
const refSource = (kind: Kind, options?: { stack: string; stage: string }) =>
  Effect.gen(function* () {
    switch (kind) {
      case "images":
        return yield* Cloudflare.Images.Variant.ref("Source", options);
      case "kv":
        return yield* Cloudflare.KV.Namespace.ref("Source", options);
      case "r2":
        return yield* Cloudflare.R2.Bucket.ref("Source", options);
      case "vectorize":
        return yield* Cloudflare.Vectorize.Index.ref("Source", options);
      case "model":
        return yield* Cloudflare.AI.Model.ref("Source", options);
      case "worker":
        return yield* Cloudflare.Worker.ref("Source", options);
    }
  });
const eventType = (kind: Kind) =>
  ({
    images: process.env.CLOUDFLARE_TEST_IMAGES_EVENT ?? "image.uploaded",
    kv: "namespace.created",
    r2: "bucket.created",
    vectorize: "index.created",
    model: "batch.queued",
    worker: "build.started",
  })[kind];

const verifySource = (source: {
  accountId: string;
  variantName?: string;
  namespaceId?: string;
  bucketName?: string;
  indexName?: string;
  modelName?: string;
  workerName?: string;
}) =>
  Effect.gen(function* () {
    const { accountId } = source;
    if (source.variantName)
      yield* images.getV1Variant({ accountId, variantId: source.variantName });
    else if (source.namespaceId)
      yield* kv.getNamespace({ accountId, namespaceId: source.namespaceId });
    else if (source.bucketName)
      yield* r2.getBucket({ accountId, bucketName: source.bucketName });
    else if (source.indexName)
      yield* vectorize.getIndex({ accountId, indexName: source.indexName });
    else if (source.modelName)
      yield* ai.getModelSchema({ accountId, model: source.modelName });
    else if (source.workerName)
      yield* workers.getScriptScriptAndVersionSetting({
        accountId,
        scriptName: source.workerName,
      });
    else throw new Error("Unknown source identity");
  });

const gone = (accountId: string, subscriptionId: string) =>
  queues.getSubscription({ accountId, subscriptionId }).pipe(
    Effect.flatMap(() => Effect.fail(new Error("Subscription still exists"))),
    Effect.catchTag("SubscriptionNotFound", () => Effect.void),
  );

const triggerEvent = (kind: Kind, accountId: string, name: string) =>
  Effect.gen(function* () {
    const eventName = `${name.slice(0, 48)}-event`;
    if (kind === "kv") {
      const namespace = yield* Effect.acquireRelease(
        kv.createNamespace({ accountId, title: eventName }),
        (namespace) =>
          kv
            .deleteNamespace({ accountId, namespaceId: namespace.id })
            .pipe(Effect.orDie),
      );
      return namespace.id;
    }
    if (kind === "r2") {
      const bucket = yield* Effect.acquireRelease(
        r2.createBucket({ accountId, name: eventName }),
        () =>
          r2
            .deleteBucket({ accountId, bucketName: eventName })
            .pipe(Effect.orDie),
      );
      return bucket.name!;
    }
    if (kind === "vectorize") {
      const index = yield* Effect.acquireRelease(
        vectorize.createIndex({
          accountId,
          name: eventName,
          config: { dimensions: 32, metric: "cosine" },
        }),
        () =>
          vectorize
            .deleteIndex({ accountId, indexName: eventName })
            .pipe(Effect.orDie),
      );
      return index.name!;
    }
    return yield* Effect.fail(new Error(`No lifecycle trigger for ${kind}`));
  });

// Account-wide subscriptions are unique per product, regardless of the selected resource.
describe.sequential("resource subscription sources", () => {
  for (const kind of [
    "images",
    "kv",
    "r2",
    "vectorize",
    "model",
    "worker",
  ] as const) {
    test.provider(
      `${kind} direct source and persisted ref retain identity and ownership`,
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const { accountId } = yield* yield* CloudflareEnvironment;
          const program = (reference: boolean) =>
            Effect.gen(function* () {
              const resource = yield* createSource(kind);
              const queue = yield* Cloudflare.Queues.Queue("EventsQueue");
              const subscription = yield* Cloudflare.Queues.Subscription(
                "Events",
                Effect.gen(function* () {
                  return {
                    source: reference ? yield* refSource(kind) : resource,
                    events: [eventType(kind)],
                    queueId: queue.queueId,
                  };
                }),
              );
              return { resource, queue, subscription };
            });
          const initial = yield* stack.deploy(program(false));
          expect(initial.subscription.accountId).toBe(accountId);
          const expected =
            kind === "model"
              ? { type: "workersAi.model", modelName: "@cf/baai/bge-m3" }
              : kind === "worker" && "workerName" in initial.resource
                ? {
                    type: "workersBuilds.worker",
                    workerName: initial.resource.workerName,
                  }
                : { type: kind };
          expect(initial.subscription.source).toEqual(expected);
          const plan = yield* stack.plan(program(false));
          expect(plan.resources.Source.downstream).toContain("Events");
          expect(plan.resources.Events.state).toHaveProperty(
            "props.sourceAccountId",
            accountId,
          );
          expect(plan.resources.Events.state).toHaveProperty(
            "props.source",
            expected,
          );
          const observed = yield* queues.getSubscription({
            accountId,
            subscriptionId: initial.subscription.subscriptionId,
          });
          expect(observed.source).toEqual(expect.objectContaining(expected));
          const receivesLifecycle =
            kind === "kv" || kind === "r2" || kind === "vectorize";
          if (receivesLifecycle) {
            yield* queues.createConsumer({
              accountId,
              queueId: initial.queue.queueId,
              type: "http_pull",
            });
            yield* queues
              .pullMessage({
                accountId,
                queueId: initial.queue.queueId,
                batchSize: 1,
              })
              .pipe(
                Effect.retry({
                  while: (error) => error._tag === "QueueHttpPullNotEnabled",
                  schedule: Schedule.spaced("2 seconds"),
                  times: 8,
                }),
              );
          }
          const referenced = yield* stack.deploy(program(true));
          expect(referenced.subscription.subscriptionId).toBe(
            initial.subscription.subscriptionId,
          );
          if (receivesLifecycle) {
            const identity = yield* triggerEvent(
              kind,
              accountId,
              referenced.queue.queueName,
            );
            const bodies: string[] = [];
            yield* Effect.gen(function* () {
              const batch = yield* queues
                .pullMessage({
                  accountId,
                  queueId: referenced.queue.queueId,
                  batchSize: 100,
                  visibilityTimeoutMs: 1000,
                })
                .pipe(
                  Effect.retry({
                    while: (error) => error._tag === "QueueHttpPullNotEnabled",
                    schedule: Schedule.spaced("2 seconds"),
                    times: 8,
                  }),
                );
              for (const message of batch.messages ?? []) {
                if (message.body) bodies.push(message.body);
              }
              const acks = (batch.messages ?? []).flatMap((message) =>
                message.leaseId ? [{ leaseId: message.leaseId }] : [],
              );
              if (acks.length)
                yield* queues.ackMessage({
                  accountId,
                  queueId: referenced.queue.queueId,
                  acks,
                });
            }).pipe(
              Effect.repeat({
                schedule: Schedule.spaced("5 seconds"),
                times: 10,
                until: () =>
                  bodies.some(
                    (body) =>
                      body.includes(`cf.${kind}.${eventType(kind)}`) &&
                      body.includes(identity!) &&
                      body.includes(accountId) &&
                      body.includes(referenced.subscription.subscriptionId),
                  ),
              }),
              Effect.timeout("60 seconds"),
            );
            if (!bodies.length)
              yield* Effect.logInfo("Empty subscription delivery", {
                subscription: yield* queues.getSubscription({
                  accountId,
                  subscriptionId: referenced.subscription.subscriptionId,
                }),
                queue: yield* queues.getQueue({
                  accountId,
                  queueId: referenced.queue.queueId,
                }),
                metrics: yield* queues.getMetricsQueue({
                  accountId,
                  queueId: referenced.queue.queueId,
                }),
                identity,
              });
            expect(
              bodies.some(
                (body) =>
                  body.includes(`cf.${kind}.${eventType(kind)}`) &&
                  body.includes(identity!) &&
                  body.includes(accountId) &&
                  body.includes(referenced.subscription.subscriptionId),
              ),
            ).toBe(true);
          }
          yield* stack.deploy(createSource(kind));
          yield* gone(accountId, initial.subscription.subscriptionId);
          yield* verifySource(initial.resource);
          yield* stack.destroy();
          if (kind === "model")
            yield* ai.getModelSchema({ accountId, model: "@cf/baai/bge-m3" });
        }).pipe(
          Effect.scoped,
          Effect.ensuring(stack.destroy().pipe(Effect.orDie)),
        ),
      { timeout: 120_000, exclusive: true },
    );
  }

  test.provider(
    "cross-stack and cross-stage namespace ref does not own the source",
    (stack) => {
      const host = TestCore.scratchStack(
        { providers: Cloudflare.providers(), stage: `${stack.stage}-host` },
        "SubscriptionRefHost",
        "test/Cloudflare/Queue/SubscriptionSources.test.ts",
      );
      return Effect.gen(function* () {
        yield* stack.destroy();
        yield* host.destroy();
        const source = yield* host.deploy(Cloudflare.KV.Namespace("Source"));
        const program = Effect.gen(function* () {
          const queue = yield* Cloudflare.Queues.Queue("Queue");
          return yield* Cloudflare.Queues.Subscription("Events", {
            source: yield* refSource("kv", {
              stack: host.name,
              stage: host.stage,
            }),
            events: ["namespace.created"],
            queueId: queue.queueId,
          });
        });
        const subscription = yield* stack.deploy(program);
        expect(subscription.source).toEqual({ type: "kv" });
        const plan = yield* stack.plan(program);
        expect(
          Object.values(plan.resources).some(
            (node) => node.resource.Type === "Cloudflare.KV.Namespace",
          ),
        ).toBe(false);
        yield* stack.destroy();
        yield* verifySource(source);
        yield* host.destroy();
      }).pipe(
        Effect.ensuring(
          stack.destroy().pipe(Effect.andThen(host.destroy()), Effect.orDie),
        ),
      );
    },
    { timeout: 120_000, exclusive: true },
  );

  test.provider(
    "a source reference from another account is rejected before subscription creation",
    (stack) => {
      const host = TestCore.scratchStack(
        { providers: Cloudflare.providers(), stage: `${stack.stage}-host` },
        "SubscriptionAccountHost",
        "test/Cloudflare/Queue/SubscriptionSources.test.ts",
      );
      return Effect.gen(function* () {
        yield* stack.destroy();
        yield* host.destroy();
        const environment = yield* yield* CloudflareEnvironment;
        const hosted = yield* host.deploy(
          Effect.gen(function* () {
            const source = yield* Cloudflare.KV.Namespace("Source");
            const queue = yield* Cloudflare.Queues.Queue("Queue");
            return { source, queue };
          }),
        );
        const rejecting = TestCore.scratchStack(
          {
            providers: Layer.mergeAll(
              Cloudflare.providers(),
              Layer.succeed(
                CloudflareEnvironment,
                Effect.succeed({
                  ...environment,
                  accountId: "00000000000000000000000000000000",
                }),
              ),
            ),
            stage: stack.stage,
          },
          "SubscriptionAccountMismatch",
          "test/Cloudflare/Queue/SubscriptionSources.test.ts",
        );
        const cleanup = TestCore.scratchStack(
          { providers: Cloudflare.providers(), stage: stack.stage },
          "SubscriptionAccountMismatch",
          "test/Cloudflare/Queue/SubscriptionSources.test.ts",
        );
        yield* cleanup.destroy();
        yield* Effect.addFinalizer(() => cleanup.destroy().pipe(Effect.orDie));
        const mismatch = yield* rejecting
          .deploy(
            Effect.gen(function* () {
              return yield* Cloudflare.Queues.Subscription("Events", {
                source: yield* refSource("kv", {
                  stack: host.name,
                  stage: host.stage,
                }),
                events: ["namespace.created"],
                queueId: hosted.queue.queueId,
              });
            }),
          )
          .pipe(Effect.exit);
        expect(Exit.isFailure(mismatch)).toBe(true);
        if (Exit.isFailure(mismatch))
          expect(Cause.pretty(mismatch.cause)).toContain(
            "SubscriptionSourceAccountMismatch",
          );
        yield* stack.destroy();
        yield* verifySource(hosted.source);
        yield* host.destroy();
      }).pipe(
        Effect.scoped,
        Effect.ensuring(
          stack.destroy().pipe(Effect.andThen(host.destroy()), Effect.orDie),
        ),
      );
    },
    { timeout: 120_000, exclusive: true },
  );

  test.provider(
    "a foreign subscription collision preserves the original destination",
    (stack) => {
      const host = TestCore.scratchStack(
        { providers: Cloudflare.providers(), stage: `${stack.stage}-owner` },
        "SubscriptionOwner",
        "test/Cloudflare/Queue/SubscriptionSources.test.ts",
      );
      return Effect.gen(function* () {
        yield* stack.destroy();
        yield* host.destroy();
        const owner = yield* host.deploy(
          Effect.gen(function* () {
            const queue = yield* Cloudflare.Queues.Queue("Queue");
            const subscription = yield* Cloudflare.Queues.Subscription(
              "OwnedEvents",
              {
                source: { type: "kv" },
                events: ["namespace.created"],
                queueId: queue.queueId,
              },
            );
            return { queue, subscription };
          }),
        );
        const result = yield* stack
          .deploy(
            Effect.gen(function* () {
              const queue = yield* Cloudflare.Queues.Queue("Queue");
              const source = yield* Cloudflare.KV.Namespace("Source");
              return yield* Cloudflare.Queues.Subscription("ForeignEvents", {
                source,
                events: ["namespace.created"],
                queueId: queue.queueId,
              });
            }),
          )
          .pipe(Effect.exit);
        expect(Exit.isFailure(result)).toBe(true);
        if (Exit.isFailure(result))
          expect(Cause.pretty(result.cause)).toContain(
            "SubscriptionAlreadyExists",
          );
        yield* stack.destroy();
        const observed = yield* queues.getSubscription({
          accountId: owner.subscription.accountId,
          subscriptionId: owner.subscription.subscriptionId,
        });
        expect(observed.destination.queueId).toBe(owner.queue.queueId);
        expect(observed.name).toBe(owner.subscription.name);
        yield* host.destroy();
      }).pipe(
        Effect.ensuring(
          stack.destroy().pipe(Effect.andThen(host.destroy()), Effect.orDie),
        ),
      );
    },
    { timeout: 120_000, exclusive: true },
  );
});
