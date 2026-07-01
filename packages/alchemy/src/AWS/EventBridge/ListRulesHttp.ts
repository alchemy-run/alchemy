import * as eventbridge from "@distilled.cloud/aws/eventbridge";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Layer from "effect/Layer";
import * as Output from "../../Output.ts";
import { AWSEnvironment } from "../Environment.ts";
import { isFunction } from "../Lambda/Function.ts";
import type { EventBus } from "./EventBus.ts";
import { ListRules, type ListRulesRequest } from "./ListRules.ts";

export const ListRulesHttp = Layer.effect(
  ListRules,
  Effect.gen(function* () {
    const listRules = yield* eventbridge.listRules;
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
            ? Output.interpolate`${bus.eventBusArn}`
            : (`arn:aws:events:${region}:${accountId}:event-bus/default` as const);

          yield* host.bind`Allow(${host}, AWS.EventBridge.ListRules(${bus ?? "default"}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: ["events:ListRules"],
                  Resource: [resource],
                },
              ],
            },
          );
        }
      }
      return Effect.fn(`AWS.EventBridge.ListRules(${bus?.LogicalId})`)(
        function* (request?: ListRulesRequest) {
          const eventBusName = EventBusName ? yield* EventBusName : undefined;
          return yield* listRules({
            ...request,
            EventBusName:
              eventBusName && eventBusName !== "default"
                ? eventBusName
                : undefined,
          });
        },
      );
    });
  }),
);
