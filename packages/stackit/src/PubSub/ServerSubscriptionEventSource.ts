import * as pubsubData from "@distilled.cloud/stackit/pubsub_data";
import { ServerHost } from "alchemy/Runtime/Process";
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as StackitBindings from "../StackitBindings.ts";
import { BindSubscriber, pullOperation } from "./BindingHttp.ts";
import type { Subscription } from "./Subscription.ts";
import {
  SubscriptionEventSource,
  type SubscriptionEventSourceProps,
  type SubscriptionEventSourceService,
  type SubscriptionMessageHandler,
} from "./SubscriptionEventSource.ts";

const DEFAULT_MAX_MESSAGES = 10;
const DEFAULT_LONG_PULL_MILLIS = 5000;

/**
 * Failed pulls in a row before the host gives up and dies, which its platform can
 * restart. About two minutes at the backoff below, long enough for a new grant to propagate.
 */
const MAX_FAILURES = 10;
const MAX_BACKOFF_MILLIS = 30_000;

/** Kept even when a pull comes back empty at once, so a server ignoring the wait can't spin. */
const EMPTY_PULL_PAUSE = "200 millis";

/** The wait after the `attempt`th failure in a row: 1 second, doubling up to the cap. */
const backoff = (attempt: number) =>
  Duration.millis(Math.min(1000 * 2 ** (attempt - 1), MAX_BACKOFF_MILLIS));

/**
 * {@link SubscriptionEventSource} for a host with core's `ServerHost`: a long-polling
 * pull, handle, acknowledge loop in the background for the host's whole life.
 *
 * @layer
 * @provides Stackit.PubSub.SubscriptionEventSource
 */
export const ServerSubscriptionEventSource = Layer.effect(
  SubscriptionEventSource,
  Effect.gen(function* () {
    const { run } = yield* ServerHost;
    const bindSubscriber = yield* BindSubscriber;
    const pull = yield* StackitBindings.withCredentials(pullOperation);
    const acknowledge = yield* StackitBindings.withCredentials(pubsubData.ackMessages);
    const negativeAcknowledge = yield* StackitBindings.withCredentials(pubsubData.nackMessages);
    // Cast below: the service type erases `process`'s requirements, so every event source
    // implementation casts its client.
    return Effect.fn(function* <E = never, Req = never>(
      subscription: Subscription,
      props: SubscriptionEventSourceProps,
      process: SubscriptionMessageHandler<E, Req>,
    ) {
      const topicIdOf = yield* subscription.topicId;
      const regionIdOf = yield* subscription.region;
      const subscriptionIdOf = yield* subscription.subscriptionId;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bindSubscriber("Stackit.PubSub.SubscriptionEventSource", subscription);
      }

      const consume = Effect.gen(function* () {
        const place = {
          topicId: yield* topicIdOf,
          regionId: yield* regionIdOf,
          subscriptionId: yield* subscriptionIdOf,
        };

        const pullOnce = Effect.gen(function* () {
          const { messages, undecodable } = yield* pull({
            ...place,
            maxMessages: props.maxMessages ?? DEFAULT_MAX_MESSAGES,
            longPullDuration: props.longPullDuration ?? DEFAULT_LONG_PULL_MILLIS,
          });
          if (messages.length === 0 && undecodable.length === 0) {
            yield* Effect.sleep(EMPTY_PULL_PAUSE);
          }
          // It can never reach a handler, and there is no dead-letter topic, so handing it
          // back would only bring it back forever. The log is all that is left of it.
          yield* Effect.forEach(
            undecodable,
            (bad) =>
              Effect.logError(
                `Pub/Sub message ${bad.ackId} dropped on delivery ${bad.deliveryAttempts}: ${bad.reason}`,
              ).pipe(Effect.andThen(acknowledge({ ...place, ackIds: [bad.ackId] }))),
            { discard: true },
          );
          const outcomes = yield* Effect.forEach(
            messages,
            (message) =>
              Effect.gen(function* () {
                const handled = yield* Effect.exit(process(message));
                if (Exit.isSuccess(handled)) {
                  yield* acknowledge({ ...place, ackIds: [message.ackId] });
                  return true;
                }
                yield* Effect.logWarning(
                  `Pub/Sub handler failed on delivery ${message.deliveryAttempts} of ${message.ackId}: ${Cause.pretty(handled.cause)}`,
                );
                yield* negativeAcknowledge({ ...place, nackIds: [message.ackId] });
                return false;
              }),
            { concurrency: props.concurrency ?? 1 },
          );
          return outcomes.includes(false);
        });

        // Any pull that works resets the budget, so only an outage or a refusal that
        // lasts ends the host. An undelivered acknowledgement comes back as a redelivery.
        let failures = 0;
        // A handed-back message comes straight back, and nothing on the server delays it, so
        // a handler that keeps failing would otherwise spin on API calls and logs.
        let failedBatches = 0;
        while (true) {
          const outcome = yield* Effect.result(pullOnce);
          if (Result.isSuccess(outcome)) {
            failures = 0;
            failedBatches = outcome.success ? failedBatches + 1 : 0;
            if (failedBatches > 0) yield* Effect.sleep(backoff(failedBatches));
            continue;
          }
          failures += 1;
          yield* Effect.logWarning(
            `Pub/Sub pull failed (${failures} of ${MAX_FAILURES}): ${outcome.failure._tag}`,
          );
          if (failures >= MAX_FAILURES) return yield* Effect.fail(outcome.failure);
          yield* Effect.sleep(backoff(failures));
        }
      });

      yield* run(consume.pipe(Effect.orDie));
    }) as SubscriptionEventSourceService;
  }),
);
