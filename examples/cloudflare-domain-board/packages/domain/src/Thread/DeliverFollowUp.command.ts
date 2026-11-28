import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { ActorName } from "../Actor.ts";
import { ThreadId } from "./Thread.id.ts";

export class FollowUpDelivered extends Domain.Event(
  "FollowUpDelivered",
  { followUpId: Schema.String, text: Schema.String, by: ActorName },
  { description: "A scheduled note was posted in its thread." },
) {}

/**
 * A follow-up is due. Scheduled by `FollowUps`; it reports a fact, so it
 * never rejects.
 */
export class DeliverFollowUp extends Domain.Command("DeliverFollowUp", {
  input: {
    threadId: ThreadId,
    followUpId: Schema.String,
    text: Schema.String,
    by: ActorName,
  },
  events: [FollowUpDelivered],
}) {}
