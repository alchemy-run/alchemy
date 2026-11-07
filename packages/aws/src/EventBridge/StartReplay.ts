import * as eventbridge from "@distilled.cloud/aws/eventbridge";
import * as Binding from "alchemy/Binding";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AWSBindings from "../AWSBindings.ts";
import { AWSEnvironment } from "../Environment.ts";
import type { Archive } from "./Archive.ts";

export interface StartReplayRequest extends Omit<
  eventbridge.StartReplayRequest,
  "EventSourceArn" | "Destination"
> {
  /**
   * Replay destination. Defaults to the archive's source event bus — the
   * only destination EventBridge allows for a replay. Provide it explicitly
   * to narrow delivery to specific rules via `FilterArns`.
   */
  Destination?: eventbridge.ReplayDestination;
}

/**
 * Starts a replay of archived events (`events:StartReplay`).
 *
 * Bind this operation to an {@link Archive} inside a function runtime to get
 * a callable that replays a time window of archived events onto a
 * destination event bus — the runtime half of disaster-recovery and
 * backfill tooling. Provide the `StartReplayHttp` layer on the Function to
 * satisfy the binding.
 * ### Replaying Events
 * **Example:** Replay a Time Window from the Bound Archive
 * ```typescript
 * // init — bind the archive (provide AWS.EventBridge.StartReplayHttp on the Function)
 * const startReplay = yield* AWS.EventBridge.StartReplay(archive);
 *
 * // runtime — replay yesterday's events back onto the archive's source bus
 * const replay = yield* startReplay({
 *   ReplayName: "backfill-2026-07-14",
 *   EventStartTime: new Date("2026-07-14T00:00:00Z"),
 *   EventEndTime: new Date("2026-07-15T00:00:00Z"),
 * });
 * ```
 *
 * @binding
 */
export interface StartReplay extends Binding.Service<
  StartReplay,
  "AWS.EventBridge.StartReplay",
  (
    archive: Archive,
  ) => Effect.Effect<
    (
      request: StartReplayRequest,
    ) => Effect.Effect<eventbridge.StartReplayResponse, eventbridge.StartReplayError>
  >
> {}
export const StartReplay = Binding.Service<StartReplay>("AWS.EventBridge.StartReplay");

/**
 * HTTP implementation of {@link StartReplay}. At deploy time it grants
 * `events:StartReplay` on the account's replays (replay names are chosen at
 * runtime, so the grant is the `replay/*` wildcard); at runtime it calls the
 * EventBridge API with the host Function's credentials, injecting the bound
 * archive's ARN as the `EventSourceArn`. Provide this layer on the Function
 * using the binding.
 */
export const StartReplayHttp = Layer.effect(
  StartReplay,
  Effect.gen(function* () {
    const bind = yield* AWSBindings.Bind;
    const startReplay = yield* AWSBindings.withCredentials(eventbridge.startReplay);

    return Effect.fn(function* (archive: Archive) {
      const ArchiveArn = yield* archive.archiveArn;
      const EventSourceArn = yield* archive.eventSourceArn;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const { accountId, region } = yield* AWSEnvironment.current as unknown as Effect.Effect<{
          accountId: string;
          region: string;
        }>;
        yield* bind`AWS.EventBridge.StartReplay(${archive})`({
          policyStatements: [
            {
              Effect: "Allow",
              Action: ["events:StartReplay"],
              Resource: [
                `arn:aws:events:${region}:${accountId}:replay/*`,
                // StartReplay also authorizes against the source archive.
                archive.archiveArn,
                // ...and against the DESTINATION event bus. EventBridge
                // only allows replaying to the archive's source bus, so
                // that bus ARN covers every legal destination.
                archive.eventSourceArn,
              ],
            },
          ],
        });
      }
      return Effect.fn(`AWS.EventBridge.StartReplay(${archive.LogicalId})`)(function* (
        request: StartReplayRequest,
      ) {
        return yield* startReplay({
          ...request,
          EventSourceArn: yield* ArchiveArn,
          // Default the destination to the archive's source bus — the only
          // destination EventBridge accepts for a replay.
          Destination: request.Destination ?? {
            Arn: yield* EventSourceArn,
          },
        });
      });
    });
  }),
);
