import * as eventbridge from "@distilled.cloud/aws/eventbridge";
import * as Binding from "alchemy/Binding";
import * as Output from "alchemy/Output";
import { isResourceOfType } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AWSBindings from "../AWSBindings.ts";
import { AWSEnvironment } from "../Environment.ts";
import type { Endpoint } from "./Endpoint.ts";
import type { EventBus } from "./EventBus.ts";

export interface PutEventsRequest extends Omit<eventbridge.PutEventsRequest, "Entries"> {
  Entries: Array<Omit<eventbridge.PutEventsRequestEntry, "EventBusName">>;
}

/**
 * Publishes events to an EventBridge event bus (`events:PutEvents`).
 *
 * Bind this operation to an {@link EventBus} inside a function runtime to get
 * a callable that automatically injects the bus name into every entry. Omit
 * the bus argument to publish to the account's default event bus, or bind a
 * global {@link Endpoint} to publish through it (EventBridge routes each
 * event to the healthy region's bus). Provide the `PutEventsHttp` layer on
 * the Function to satisfy the binding.
 * ### Publishing Events
 * **Example:** Publish an Event from a Handler
 * ```typescript
 * // init — bind the bus (provide AWS.EventBridge.PutEventsHttp on the Function)
 * const putEvents = yield* AWS.EventBridge.PutEvents(bus);
 *
 * return {
 *   fetch: Effect.gen(function* () {
 *     // runtime — publish an event
 *     const result = yield* putEvents({
 *       Entries: [
 *         {
 *           Source: "my.app",
 *           DetailType: "OrderCreated",
 *           Detail: JSON.stringify({ orderId: "123" }),
 *         },
 *       ],
 *     });
 *     return HttpServerResponse.json({
 *       failedEntryCount: result.FailedEntryCount ?? 0,
 *     });
 *   }),
 * };
 * ```
 *
 * **Example:** Publish to the Default Event Bus
 * ```typescript
 * // omit the bus argument to target the account's default bus
 * const putEvents = yield* AWS.EventBridge.PutEvents();
 *
 * yield* putEvents({
 *   Entries: [
 *     {
 *       Source: "my.app",
 *       DetailType: "Heartbeat",
 *       Detail: JSON.stringify({ at: new Date().toISOString() }),
 *     },
 *   ],
 * });
 * ```
 *
 * ### Publishing Through a Global Endpoint
 * **Example:** Publish to a Multi-Region Endpoint
 * ```typescript
 * const putEvents = yield* AWS.EventBridge.PutEvents(endpoint);
 *
 * yield* putEvents({
 *   Entries: [
 *     {
 *       Source: "my.app",
 *       DetailType: "OrderCreated",
 *       Detail: JSON.stringify({ orderId: "123" }),
 *     },
 *   ],
 * });
 * ```
 *
 * @binding
 */
export interface PutEvents extends Binding.Service<
  PutEvents,
  "AWS.EventBridge.PutEvents",
  (
    target?: EventBus | Endpoint,
  ) => Effect.Effect<
    (
      request: PutEventsRequest,
    ) => Effect.Effect<eventbridge.PutEventsResponse, eventbridge.PutEventsError>
  >
> {}
export const PutEvents = Binding.Service<PutEvents>("AWS.EventBridge.PutEvents");

/**
 * HTTP implementation of {@link PutEvents}. At deploy time it grants
 * `events:PutEvents` on the bound bus (or the default bus, or both buses of a
 * global endpoint); at runtime it calls the EventBridge API with the host
 * Function's credentials. Provide this layer on the Function using the
 * binding.
 */
export const PutEventsHttp = Layer.effect(
  PutEvents,
  Effect.gen(function* () {
    const bind = yield* AWSBindings.Bind;
    const putEvents = yield* AWSBindings.withCredentials(eventbridge.putEvents);

    /**
     * Publish through a global endpoint: requests go to the endpoint's URL
     * (signed with SigV4A) and EventBridge routes them to the healthy
     * region's bus. Both buses are granted, since either may receive them.
     */
    const bindEndpoint = Effect.fn(function* (endpoint: Endpoint) {
      const EndpointId = yield* endpoint.endpointId;
      const EventBusArns = yield* endpoint.eventBusArns;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`AWS.EventBridge.PutEvents(${endpoint})`({
          policyStatements: [
            {
              Effect: "Allow",
              Action: ["events:PutEvents"],
              Resource: endpoint.eventBusArns,
            },
          ],
        });
      }
      return Effect.fn(`AWS.EventBridge.PutEvents(${endpoint.LogicalId})`)(function* (
        request: PutEventsRequest,
      ) {
        const endpointId = yield* EndpointId;
        // Both buses share a name; the endpoint resolves it in whichever
        // region it routes to.
        const [primary] = yield* EventBusArns;
        const eventBusName = primary!.slice(primary!.indexOf(":event-bus/") + ":event-bus/".length);
        return yield* putEvents({
          ...request,
          EndpointId: endpointId,
          Entries: request.Entries.map((entry) => ({ ...entry, EventBusName: eventBusName })),
        });
      });
    });

    return Effect.fn(function* (target?: EventBus | Endpoint) {
      if (isResourceOfType(target, "AWS.EventBridge.Endpoint")) {
        return yield* bindEndpoint(target as Endpoint);
      }
      const bus = target as EventBus | undefined;
      const EventBusName = bus ? yield* bus.eventBusName : undefined;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const { accountId, region } = yield* AWSEnvironment.current as unknown as Effect.Effect<{
          accountId: string;
          region: string;
        }>;
        // Pass the ARN as an unresolved Output — binding data is resolved
        // by the engine before the host reconciles. Eagerly yielding here
        // (during plan) produces a deferred object that serializes into an
        // invalid IAM policy (MalformedPolicyDocumentException).
        const resource = bus
          ? Output.interpolate`${bus.eventBusArn}`
          : (`arn:aws:events:${region}:${accountId}:event-bus/default` as const);

        yield* bind`AWS.EventBridge.PutEvents(${bus ?? "default"})`({
          policyStatements: [
            {
              Effect: "Allow",
              Action: ["events:PutEvents"],
              Resource: [resource],
            },
          ],
        });
      }
      return Effect.fn(`AWS.EventBridge.PutEvents(${bus?.LogicalId})`)(function* (
        request: PutEventsRequest,
      ) {
        const eventBusName = EventBusName ? yield* EventBusName : undefined;
        return yield* putEvents({
          ...request,
          Entries: request.Entries.map((entry) => ({
            ...entry,
            EventBusName: eventBusName && eventBusName !== "default" ? eventBusName : undefined,
          })),
        });
      });
    });
  }),
);
