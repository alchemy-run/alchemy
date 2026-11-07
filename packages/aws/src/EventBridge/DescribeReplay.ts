import * as eventbridge from "@distilled.cloud/aws/eventbridge";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeEventBridgeAccountHttpBinding } from "./BindingHttp.ts";

export interface DescribeReplayRequest extends eventbridge.DescribeReplayRequest {}

/**
 * Reads the progress and state of an event replay
 * (`events:DescribeReplay`).
 *
 * Bind this operation inside a function runtime to poll a replay started
 * with `StartReplay` until it completes. Provide the `DescribeReplayHttp`
 * layer on the Function to satisfy the binding.
 * ### Replaying Events
 * **Example:** Poll a Replay's State
 * ```typescript
 * // init — bind the operation (provide AWS.EventBridge.DescribeReplayHttp on the Function)
 * const describeReplay = yield* AWS.EventBridge.DescribeReplay();
 *
 * // runtime — read the replay's state and progress
 * const replay = yield* describeReplay({ ReplayName: "backfill-2026-07-14" });
 * console.log(replay.State, replay.EventLastReplayedTime);
 * ```
 *
 * @binding
 */
export interface DescribeReplay extends Binding.Service<
  DescribeReplay,
  "AWS.EventBridge.DescribeReplay",
  () => Effect.Effect<
    (
      request: DescribeReplayRequest,
    ) => Effect.Effect<eventbridge.DescribeReplayResponse, eventbridge.DescribeReplayError>
  >
> {}
export const DescribeReplay = Binding.Service<DescribeReplay>("AWS.EventBridge.DescribeReplay");

/**
 * HTTP implementation of {@link DescribeReplay}. At deploy time it grants
 * `events:DescribeReplay` on the account's replays; at runtime it calls the
 * EventBridge API with the host Function's credentials. Provide this layer
 * on the Function using the binding.
 */
export const DescribeReplayHttp = Layer.effect(
  DescribeReplay,
  makeEventBridgeAccountHttpBinding({
    tag: "AWS.EventBridge.DescribeReplay",
    operation: eventbridge.describeReplay,
    actions: ["events:DescribeReplay"],
    resources: ({ accountId, region }) => [`arn:aws:events:${region}:${accountId}:replay/*`],
  }),
);
