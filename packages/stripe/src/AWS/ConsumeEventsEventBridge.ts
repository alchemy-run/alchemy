import * as AWS from "@alchemy.run/aws";
import { GetCoreEvent } from "@distilled.cloud/stripe/stripe";
import * as Namespace from "alchemy/Namespace";
import * as Output from "alchemy/Output";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { EventSource, type ConsumeEventsProps, type EventSourceService } from "../ConsumeEvents.ts";
import { EventDestination } from "../EventDestination.ts";
import { isThinEventClass, type StripeEventClass, type StripeEventInstance } from "../Events.ts";
import { decodeThinEvent } from "../internal/thin.ts";
import { attachStripeToken, authorizeWith } from "../StripeHttp.ts";

/** `arn:aws:lambda:<region>:<account>:function:<name>` → region and account. */
const lambdaArnPart = (arn: string, index: 3 | 4) => arn.split(":")[index] ?? "";

/**
 * `arn:aws:events:<region>::event-source/aws.partner/stripe.com/…` → the
 * partner event source name, which the event bus must be named after.
 */
const partnerSourceName = (arn: string | undefined) => arn?.split(":event-source/")[1] ?? "";

/**
 * Receive Stripe events on an AWS Lambda Function through Amazon
 * EventBridge, instead of a webhook. `consumeEvents` code is unchanged;
 * provide this layer in place of `Stripe.ConsumeEventsLive`.
 *
 * For each payload style it deploys a Stripe event destination targeting
 * the Function's account and region, the partner event bus that receives
 * it, and a rule per event type that invokes the Function. Deliveries are
 * authorized by IAM, so there is no signing secret and the Function needs
 * no public URL. EventBridge retries failed invocations for up to 24 hours,
 * and the bus can be archived and replayed. Partner events are billed by
 * EventBridge (about $1 per million); a webhook costs nothing extra.
 *
 * ### Receiving events on a Lambda
 * **Example:** Subscription events through EventBridge
 * ```typescript
 * import * as AWS from "@alchemy.run/aws";
 * import * as Stripe from "@alchemy.run/stripe";
 * import { ConsumeEventsEventBridge } from "@alchemy.run/stripe/AWS";
 * import * as Effect from "effect/Effect";
 *
 * export default class Billing extends AWS.Lambda.Function<Billing>()(
 *   "Billing",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     yield* Stripe.consumeEvents(
 *       { events: [Stripe.InvoicePaid, Stripe.MeterErrorReportTriggered] },
 *       (event) => Effect.log(event.type),
 *     );
 *     return {};
 *   }).pipe(Effect.provide(ConsumeEventsEventBridge)),
 * ) {}
 * ```
 *
 * @layer
 * @provides Stripe.EventSource
 * @peer @alchemy.run/aws
 * @product EventBridge delivery
 */
export const ConsumeEventsEventBridge = Layer.effect(
  EventSource,
  Effect.gen(function* () {
    const busEvents = yield* AWS.EventBridge.EventSource;
    const host = yield* AWS.Lambda.eventSourceHost("Stripe.ConsumeEventsEventBridge");

    return Effect.fn(function* (
      id: string,
      props: ConsumeEventsProps,
      process: (event: StripeEventInstance) => Effect.Effect<void, never, never>,
    ) {
      const snapshotEvents = props.events.filter((event) => !isThinEventClass(event));
      const thinEvents = props.events.filter(isThinEventClass);

      const subscribe = (
        logicalId: string,
        payload: "snapshot" | "thin",
        events: readonly StripeEventClass[],
        dispatch: (detail: Record<string, unknown>) => Effect.Effect<void, never, RuntimeContext>,
      ) =>
        Effect.gen(function* () {
          const types = events.map((event) => event.type);
          // The destination and its partner bus are deploy-time resources;
          // the bus is looked up by name, so the runtime only listens.
          const bus = yield* Namespace.push(
            host.LogicalId,
            Effect.gen(function* () {
              const destination = yield* EventDestination(logicalId, {
                eventPayload: payload,
                enabledEvents: types,
                amazonEventbridge: {
                  awsAccountId: Output.map(host.functionArn, (arn) => lambdaArnPart(arn, 4)),
                  awsRegion: Output.map(host.functionArn, (arn) => lambdaArnPart(arn, 3)),
                },
              });
              const sourceName = Output.map(destination.awsEventSourceArn, partnerSourceName);
              return yield* AWS.EventBridge.EventBus(`${logicalId}Bus`, {
                name: sourceName,
                eventSourceName: sourceName,
              });
            }),
          );
          const byType = new Map(events.map((event) => [event.type, event] as const));
          yield* busEvents(
            { id: `${logicalId}Rule`, bus, pattern: { "detail-type": types } },
            (records: Stream.Stream<AWS.EventBridge.EventRecord<Record<string, unknown>>>) =>
              records.pipe(
                Stream.runForEach((record) =>
                  byType.has(record["detail-type"]) ? dispatch(record.detail) : Effect.void,
                ),
              ),
          );
        });

      if (snapshotEvents.length > 0) {
        const byType = new Map(snapshotEvents.map((event) => [event.type, event] as const));
        yield* subscribe(id, "snapshot", snapshotEvents, (detail) => {
          const Ctor = byType.get(typeof detail.type === "string" ? detail.type : "");
          if (Ctor === undefined) return Effect.void;
          const data = detail.data as { object?: unknown } | undefined;
          return process(new Ctor((data?.object ?? data) as never));
        });
      }

      if (thinEvents.length > 0) {
        // A thin event only carries its id: fetch it with a key that can read events.
        const authorize = authorizeWith(
          yield* attachStripeToken(undefined, ["events_read"], "Stripe.ConsumeEvents"),
        );
        const byType = new Map(thinEvents.map((event) => [event.type, event] as const));
        yield* subscribe(`${id}Thin`, "thin", thinEvents, (detail) =>
          Effect.gen(function* () {
            const Ctor = byType.get(typeof detail.type === "string" ? detail.type : "");
            if (Ctor === undefined || typeof detail.id !== "string") return;
            const event = yield* authorize(GetCoreEvent({ id: detail.id }));
            yield* process(new Ctor(yield* decodeThinEvent(event)));
          }).pipe(Effect.orDie),
        );
      }
    }) as EventSourceService;
  }),
).pipe(Layer.provide(AWS.Lambda.EventSource));
