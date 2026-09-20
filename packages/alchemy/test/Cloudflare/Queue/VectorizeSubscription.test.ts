import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Test from "@/Test/Alchemy";
import * as queues from "@distilled.cloud/cloudflare/queues";
import * as vectorize from "@distilled.cloud/cloudflare/vectorize";
import { expect } from "alchemy-test";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { SubscriptionEvent } from "./SubscriptionEvent.ts";
import { makeSubscriptionCleanup } from "./SubscriptionCleanup.ts";

const { test } = Test.make({ providers: Cloudflare.providers() });
// Cloudflare can route fresh events to the previous Queue after either change.
for (const change of ["replacement", "update"] as const) {
  const enabled =
    change === "replacement"
      ? process.env.CLOUDFLARE_TEST_VECTORIZE_IMMEDIATE_REPLACEMENT === "1"
      : process.env.CLOUDFLARE_TEST_VECTORIZE_IMMEDIATE_UPDATE === "1";
  test.provider.skipIf(!enabled)(
    `Vectorize immediately routes post-${change} events to the current subscription`,
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const { accountId } = yield* yield* CloudflareEnvironment;
        const start = yield* Clock.currentTimeMillis;
        const cleanup = makeSubscriptionCleanup();
        const makeQueue = (suffix: string) =>
          Effect.gen(function* () {
            const queue = yield* Effect.acquireRelease(
              queues.createQueue({
                accountId,
                queueName: `alchemy-vectorize-replacement-${suffix}`,
              }),
              (queue) =>
                queues
                  .deleteQueue({ accountId, queueId: queue.queueId! })
                  .pipe(cleanup),
            );
            yield* queues.createConsumer({
              accountId,
              queueId: queue.queueId!,
              type: "http_pull",
            });
            return queue.queueId!;
          });
        const a = yield* makeQueue("a");
        const b = yield* makeQueue("b");
        const makeSubscription = (queueId: string) =>
          Effect.acquireRelease(
            queues.createSubscription({
              accountId,
              name: `native-${queueId}`,
              source: { type: "vectorize" },
              events: ["index.created"],
              enabled: true,
              destination: { type: "queues.queue", queueId },
            }),
            (subscription) =>
              queues
                .deleteSubscription({
                  accountId,
                  subscriptionId: subscription.id,
                })
                .pipe(
                  Effect.catchTag("SubscriptionNotFound", () => Effect.void),
                  cleanup,
                ),
          );
        const create = (name: string) =>
          Effect.gen(function* () {
            const index = yield* Effect.acquireRelease(
              vectorize.createIndex({
                accountId,
                name,
                config: { dimensions: 32, metric: "cosine" },
              }),
              () =>
                vectorize
                  .deleteIndex({ accountId, indexName: name })
                  .pipe(cleanup),
            );
            yield* Effect.logInfo(`Native ${change} create`, {
              elapsedMs: (yield* Clock.currentTimeMillis) - start,
              index,
            });
            return name;
          });
        const received: { queueId: string; event: SubscriptionEvent }[] = [];
        const pull = (queueId: string) =>
          Effect.gen(function* () {
            const batch = yield* queues
              .pullMessage({
                accountId,
                queueId,
                batchSize: 100,
                visibilityTimeoutMs: 30_000,
              })
              .pipe(
                Effect.retry({
                  while: (error) => error._tag === "QueueHttpPullNotEnabled",
                  schedule: Schedule.spaced("2 seconds"),
                  times: 8,
                }),
              );
            for (const message of batch.messages ?? []) {
              if (message.body) {
                const event = yield* Schema.decodeUnknownEffect(
                  SubscriptionEvent,
                )(message.body);
                expect(event.type).toBe("cf.vectorize.index.created");
                expect(event.source.type).toBe("vectorize");
                expect(event.metadata.accountId).toBe(accountId);
                received.push({ queueId, event });
                yield* Effect.logInfo(`Native ${change} receipt`, {
                  elapsedMs: (yield* Clock.currentTimeMillis) - start,
                  queueId,
                  event,
                });
              }
            }
            const acks = (batch.messages ?? []).flatMap(({ leaseId }) =>
              leaseId ? [{ leaseId }] : [],
            );
            if (acks.length) {
              const ack = yield* queues.ackMessage({
                accountId,
                queueId,
                acks,
              });
              expect(ack.ackCount).toBe(acks.length);
              expect(Object.keys(ack.warnings ?? {})).toHaveLength(0);
            }
          });
        const old = yield* makeSubscription(a);
        yield* pull(b);
        const initialProbes: string[] = [];
        const initiallyReady = () =>
          received.some(
            ({ queueId, event }) =>
              queueId === a &&
              event.metadata.eventSubscriptionId === old.id &&
              initialProbes.includes(event.payload.name!),
          );
        yield* Effect.gen(function* () {
          initialProbes.push(yield* create(`vec-${a}-${initialProbes.length}`));
          yield* pull(a);
        }).pipe(
          Effect.repeat({
            schedule: Schedule.spaced("7 seconds"),
            times: 8,
            until: initiallyReady,
          }),
        );
        expect(initiallyReady()).toBe(true);
        const current = yield* Effect.gen(function* () {
          if (change === "update") {
            const updated = yield* queues.patchSubscription({
              accountId,
              subscriptionId: old.id,
              destination: { type: "queues.queue", queueId: b },
            });
            expect(updated.id).toBe(old.id);
            return updated;
          }
          yield* queues.deleteSubscription({
            accountId,
            subscriptionId: old.id,
          });
          yield* queues
            .getSubscription({ accountId, subscriptionId: old.id })
            .pipe(
              Effect.flatMap(() =>
                Effect.fail(new Error("Deleted subscription still exists")),
              ),
              Effect.catchTag("SubscriptionNotFound", () => Effect.void),
            );
          return yield* makeSubscription(b);
        });
        const observed = yield* queues.getSubscription({
          accountId,
          subscriptionId: current.id,
        });
        expect(observed.destination.queueId).toBe(b);
        yield* Effect.logInfo(`Native ${change} identities`, {
          oldSubscription: old.id,
          oldQueue: a,
          newSubscription: current.id,
          newQueue: b,
          elapsedMs: (yield* Clock.currentTimeMillis) - start,
        });
        const identities = yield* Effect.forEach([0, 1, 2], (i) =>
          create(`vec-${b}-after-${change}-${i}`),
        );
        yield* Effect.gen(function* () {
          yield* pull(a);
          yield* pull(b);
        }).pipe(
          Effect.repeat({
            schedule: Schedule.spaced("2 seconds"),
            times: 4,
            until: () =>
              identities.every((identity) =>
                received.some(({ event }) => event.payload.name === identity),
              ),
          }),
        );
        const deliveries = received.filter(({ event }) =>
          identities.includes(event.payload.name!),
        );
        yield* Effect.logInfo(`Native ${change} result`, {
          identities,
          deliveries,
        });
        for (const identity of identities) {
          expect(
            deliveries.some(
              ({ queueId, event }) =>
                queueId === b &&
                event.metadata.eventSubscriptionId === current.id &&
                event.payload.name === identity,
            ),
          ).toBe(true);
        }
        expect(deliveries.some(({ queueId }) => queueId === a)).toBe(false);
        yield* stack.destroy();
      }).pipe(
        Effect.timeout("90 seconds"),
        Effect.scoped,
        Effect.ensuring(
          stack
            .destroy()
            .pipe(
              Effect.timeout("5 seconds"),
              Effect.orDie,
              Effect.interruptible,
            ),
        ),
      ),
    { timeout: 120_000, exclusive: true },
  );
}
