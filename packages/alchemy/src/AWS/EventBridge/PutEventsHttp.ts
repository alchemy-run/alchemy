import * as eventbridge from "@distilled.cloud/aws/eventbridge";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Layer from "effect/Layer";
import { AWSEnvironment } from "../Environment.ts";
import { isFunction } from "../Lambda/Function.ts";
import type { EventBus } from "./EventBus.ts";
import { PutEvents, type PutEventsRequest } from "./PutEvents.ts";

export const PutEventsHttp = Layer.effect(
  PutEvents,
  Effect.gen(function* () {
    const putEvents = yield* eventbridge.putEvents;

    return Effect.fn(function* (bus?: EventBus) {
      const EventBusName = bus ? yield* bus.eventBusName : undefined;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isFunction(host)) {
          const { accountId, region } =
            yield* AWSEnvironment.current as unknown as Effect.Effect<{
              accountId: string;
              region: string;
            }>;
          const resource = bus
            ? yield* yield* bus.eventBusArn
            : (`arn:aws:events:${region}:${accountId}:event-bus/default` as const);

          yield* host.bind`Allow(${host}, AWS.EventBridge.PutEvents(${bus ?? "default"}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: ["events:PutEvents"],
                  Resource: [resource],
                },
              ],
            },
          );
        }
      }
      return Effect.fn(`AWS.EventBridge.PutEvents(${bus?.LogicalId})`)(
        function* (request: PutEventsRequest) {
          const eventBusName = EventBusName ? yield* EventBusName : undefined;
          return yield* putEvents({
            ...request,
            Entries: request.Entries.map((entry) => ({
              ...entry,
              EventBusName:
                eventBusName && eventBusName !== "default"
                  ? eventBusName
                  : undefined,
            })),
          });
        },
      );
    });
  }),
);
