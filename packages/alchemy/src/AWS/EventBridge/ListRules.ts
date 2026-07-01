import * as eventbridge from "@distilled.cloud/aws/eventbridge";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { EventBus } from "./EventBus.ts";

export interface ListRulesRequest extends Omit<
  eventbridge.ListRulesRequest,
  "EventBusName"
> {}

/** @binding */
export interface ListRules extends Binding.Service<
  ListRules,
  "AWS.EventBridge.ListRules",
  (
    bus?: EventBus,
  ) => Effect.Effect<
    (
      request?: ListRulesRequest,
    ) => Effect.Effect<
      eventbridge.ListRulesResponse,
      eventbridge.ListRulesError
    >
  >
> {}
export const ListRules = Binding.Service<ListRules>(
  "AWS.EventBridge.ListRules",
);
