import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { ActorName } from "../Actor.ts";
import { ThreadId } from "../Thread/Thread.id.ts";

export class LeaseExpired extends Domain.Event(
  "LeaseExpired",
  { by: ActorName, claim: Schema.String },
  { description: "A claim's lease ran out before its holder renewed it. The task is ready again." },
) {}

/**
 * A claim's lease is due. Scheduled by `Leases` for the lease's end; it
 * reports a fact, so it never rejects, and it records nothing if the claim
 * was renewed, completed or released in time.
 */
export class ExpireLease extends Domain.Command("ExpireLease", {
  input: { threadId: ThreadId, claim: Schema.String },
  events: [LeaseExpired],
}) {}
