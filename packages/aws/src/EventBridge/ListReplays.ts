import * as eventbridge from "@distilled.cloud/aws/eventbridge";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeEventBridgeAccountHttpBinding } from "./BindingHttp.ts";

export interface ListReplaysRequest extends eventbridge.ListReplaysRequest {}

/**
 * Lists the event replays in the account (`events:ListReplays`).
 *
 * Bind this operation inside a function runtime to enumerate replays,
 * optionally filtered by name prefix, state, or source archive. Provide the
 * `ListReplaysHttp` layer on the Function to satisfy the binding.
 * ### Replaying Events
 * **Example:** List Running Replays
 * ```typescript
 * // init — bind the operation (provide AWS.EventBridge.ListReplaysHttp on the Function)
 * const listReplays = yield* AWS.EventBridge.ListReplays();
 *
 * // runtime — enumerate replays currently running
 * const { Replays } = yield* listReplays({ State: "RUNNING" });
 * ```
 *
 * @binding
 */
export interface ListReplays extends Binding.Service<
  ListReplays,
  "AWS.EventBridge.ListReplays",
  () => Effect.Effect<
    (
      request?: ListReplaysRequest,
    ) => Effect.Effect<eventbridge.ListReplaysResponse, eventbridge.ListReplaysError>
  >
> {}
export const ListReplays = Binding.Service<ListReplays>("AWS.EventBridge.ListReplays");

/**
 * HTTP implementation of {@link ListReplays}. At deploy time it grants
 * `events:ListReplays` (the action does not support resource-level
 * permissions); at runtime it calls the EventBridge API with the host
 * Function's credentials. Provide this layer on the Function using the
 * binding.
 */
export const ListReplaysHttp = Layer.effect(
  ListReplays,
  makeEventBridgeAccountHttpBinding({
    tag: "AWS.EventBridge.ListReplays",
    operation: eventbridge.listReplays,
    actions: ["events:ListReplays"],
  }),
);
