import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { ActorName } from "../Actor.ts";
import { Session } from "../Session.middleware.ts";
import { NotStarted } from "./NotStarted.rejection.ts";
import { ThreadId } from "./Thread.id.ts";

export class FollowUpScheduled extends Domain.Event(
  "FollowUpScheduled",
  {
    followUpId: Schema.String,
    text: Schema.String,
    at: Schema.Int,
    by: ActorName,
  },
  { description: "Someone asked the board to post a note in a thread later." },
) {}

export class ScheduleFollowUp extends Domain.Command(
  "ScheduleFollowUp",
  {
    middleware: [Session],
    input: {
      threadId: ThreadId,
      text: Schema.String,
      inSeconds: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 7 * 24 * 60 * 60 })),
    },
    events: [FollowUpScheduled],
    rejects: [NotStarted],
    reply: { followUpId: Schema.String, at: Schema.Int },
  },
  {
    description:
      "Post a note in a thread later, such as 'Check CI for the linked pull request' in 300 seconds. Whoever watches the thread sees it then.",
  },
) {}
