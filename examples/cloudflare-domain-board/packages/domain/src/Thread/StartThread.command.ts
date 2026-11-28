import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { ActorName } from "../Actor.ts";
import { ChannelId } from "../Channel/Channel.id.ts";
import { Labels } from "../Labels.ts";
import { Session } from "../Session.middleware.ts";
import { AlreadyStarted } from "./AlreadyStarted.rejection.ts";
import { ThreadId } from "./Thread.id.ts";

export class ThreadStarted extends Domain.Event(
  "ThreadStarted",
  {
    channel: ChannelId,
    title: Schema.String,
    text: Schema.String,
    labels: Labels,
    author: ActorName,
  },
  { description: "Someone started a conversation in a channel." },
) {}

export class StartThread extends Domain.Command(
  "StartThread",
  {
    middleware: [Session],
    input: {
      threadId: ThreadId,
      channel: ChannelId,
      title: Schema.String,
      text: Schema.String,
      labels: Schema.optional(Labels),
    },
    events: [ThreadStarted],
    rejects: [AlreadyStarted],
  },
  {
    description:
      "Start a conversation in a channel: a bug report, an incident, a question. The first message is its text.",
  },
) {}
