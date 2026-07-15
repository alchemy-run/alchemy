import type * as eventbridge from "@distilled.cloud/aws/eventbridge";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Archive } from "./Archive.ts";

export interface StartReplayRequest extends Omit<
  eventbridge.StartReplayRequest,
  "EventSourceArn"
> {}

/**
 * Starts a replay of archived events (`events:StartReplay`).
 *
 * Bind this operation to an {@link Archive} inside a function runtime to get
 * a callable that replays a time window of archived events onto a
 * destination event bus — the runtime half of disaster-recovery and
 * backfill tooling. Provide the `StartReplayHttp` layer on the Function to
 * satisfy the binding.
 * @binding
 * @section Replaying Events
 * @example Replay a Time Window from the Bound Archive
 * ```typescript
 * // init — bind the archive (provide AWS.EventBridge.StartReplayHttp on the Function)
 * const startReplay = yield* AWS.EventBridge.StartReplay(archive);
 *
 * // runtime — replay yesterday's events back onto the bus
 * const replay = yield* startReplay({
 *   ReplayName: "backfill-2026-07-14",
 *   EventStartTime: new Date("2026-07-14T00:00:00Z"),
 *   EventEndTime: new Date("2026-07-15T00:00:00Z"),
 *   Destination: { Arn: busArn },
 * });
 * ```
 */
export interface StartReplay extends Binding.Service<
  StartReplay,
  "AWS.EventBridge.StartReplay",
  (
    archive: Archive,
  ) => Effect.Effect<
    (
      request: StartReplayRequest,
    ) => Effect.Effect<
      eventbridge.StartReplayResponse,
      eventbridge.StartReplayError
    >
  >
> {}
export const StartReplay = Binding.Service<StartReplay>(
  "AWS.EventBridge.StartReplay",
);
