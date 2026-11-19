import * as Schema from "effect/Schema";
import { ActorName } from "../Actor.ts";
import { ThreadId } from "../Thread/Thread.id.ts";

/**
 * Where a task stands. `Blocked` waits for the tasks it depends on; `Ready`
 * may be claimed; `Claimed` is held by one actor until its lease runs out;
 * `Done` is finished.
 */
export const TaskStatus = Schema.Union([
  Schema.TaggedStruct("Blocked", { waitingOn: Schema.Array(ThreadId) }),
  Schema.TaggedStruct("Ready", {}),
  Schema.TaggedStruct("Claimed", {
    by: ActorName,
    claim: Schema.String,
    leaseUntil: Schema.Int,
  }),
  Schema.TaggedStruct("Done", { by: ActorName }),
]);
export type TaskStatus = typeof TaskStatus.Type;

/** How long a claim lasts unless the command says otherwise: 30 minutes. */
export const DEFAULT_LEASE_SECONDS = 30 * 60;

/** A lease in seconds: at least a minute, at most a day. */
export const LeaseSeconds = Schema.Int.check(
  Schema.isBetween({ minimum: 60, maximum: 24 * 60 * 60 }),
).annotate({ description: "How long the claim lasts, in seconds. Default 1800" });
