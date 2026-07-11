import type * as eventbridge from "@distilled.cloud/aws/eventbridge";
import type * as Effect from "effect/Effect";
import type * as Sink from "effect/Sink";
import * as Binding from "../../Binding.ts";
import type { BatchRetryExhaustedError } from "../internal/BatchedSink.ts";
import type { EventBus } from "./EventBus.ts";

/**
 * A raw `PutEventsRequestEntry` minus `EventBusName`, which the sink derives
 * from the bus it is bound to. Callers stay in control of `Source`,
 * `DetailType`, `Detail`, `Time`, `Resources`, and `TraceHeader` — no
 * auto-marshalling.
 */
export interface BusSinkEntry extends Omit<
  eventbridge.PutEventsRequestEntry,
  "EventBusName"
> {}

export type BusSinkError =
  | eventbridge.PutEventsError
  | BatchRetryExhaustedError<BusSinkEntry>;

/**
 * A batching sink over EventBridge `PutEvents` (10 entries / 256 KiB per
 * call). Per-entry failures with transient error codes (`ThrottlingException`,
 * `InternalFailure`) are re-submitted on a bounded schedule; any other
 * per-entry `ErrorCode` (e.g. `MalformedDetail`) is permanent — those entries
 * are dropped and surfaced via a logged warning. Exhausting retries fails the
 * sink with a typed `BatchRetryExhaustedError` carrying the stranded entries.
 *
 * Omit the bus argument to publish to the account's default event bus.
 *
 * @binding
 */
export interface BusSink extends Binding.Service<
  BusSink,
  "AWS.EventBridge.BusSink",
  (
    bus?: EventBus,
  ) => Effect.Effect<
    Sink.Sink<void, BusSinkEntry, readonly BusSinkEntry[], BusSinkError>
  >
> {}

export const BusSink = Binding.Service<BusSink>("AWS.EventBridge.BusSink");
