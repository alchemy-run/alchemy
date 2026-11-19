import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { ActorName } from "../Actor.ts";
import { Session } from "../Session.middleware.ts";
import { NotStarted } from "./NotStarted.rejection.ts";
import { ThreadId } from "./Thread.id.ts";

export class MessagePosted extends Domain.Event(
  "MessagePosted",
  { text: Schema.String, author: ActorName },
  { description: "Someone replied in a thread." },
) {}

export class PostMessage extends Domain.Command(
  "PostMessage",
  {
    middleware: [Session],
    input: { threadId: ThreadId, text: Schema.String },
    events: [MessagePosted],
    rejects: [NotStarted],
  },
  {
    description:
      "Reply in a thread: a status update while working on a task, a question, a link to a pull request.",
  },
) {}
