import * as eventbridge from "@distilled.cloud/aws/eventbridge";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeEventBridgeAccountHttpBinding } from "./BindingHttp.ts";

export interface CancelReplayRequest extends eventbridge.CancelReplayRequest {}

/**
 * Cancels a running event replay (`events:CancelReplay`).
 *
 * Bind this operation inside a function runtime to abort a replay started
 * with `StartReplay`. Cancelling a replay that already completed fails with
 * the typed `IllegalStatusException`. Provide the `CancelReplayHttp` layer
 * on the Function to satisfy the binding.
 * ### Replaying Events
 * **Example:** Cancel a Running Replay
 * ```typescript
 * // init — bind the operation (provide AWS.EventBridge.CancelReplayHttp on the Function)
 * const cancelReplay = yield* AWS.EventBridge.CancelReplay();
 *
 * // runtime — abort the replay
 * yield* cancelReplay({ ReplayName: "backfill-2026-07-14" });
 * ```
 *
 * @binding
 */
export interface CancelReplay extends Binding.Service<
  CancelReplay,
  "AWS.EventBridge.CancelReplay",
  () => Effect.Effect<
    (
      request: CancelReplayRequest,
    ) => Effect.Effect<eventbridge.CancelReplayResponse, eventbridge.CancelReplayError>
  >
> {}
export const CancelReplay = Binding.Service<CancelReplay>("AWS.EventBridge.CancelReplay");

/**
 * HTTP implementation of {@link CancelReplay}. At deploy time it grants
 * `events:CancelReplay` on the account's replays; at runtime it calls the
 * EventBridge API with the host Function's credentials. Provide this layer
 * on the Function using the binding.
 */
export const CancelReplayHttp = Layer.effect(
  CancelReplay,
  makeEventBridgeAccountHttpBinding({
    tag: "AWS.EventBridge.CancelReplay",
    operation: eventbridge.cancelReplay,
    actions: ["events:CancelReplay"],
    resources: ({ accountId, region }) => [`arn:aws:events:${region}:${accountId}:replay/*`],
  }),
);
