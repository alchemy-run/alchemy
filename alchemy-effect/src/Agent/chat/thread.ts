import * as S from "effect/Schema";

export type ThreadId = string;
export const ThreadId = S.String.annotations({
  description: "The ID of the thread",
});

export class Thread extends S.Class<Thread>("Thread")({
  threadId: ThreadId,
  participants: S.Array(S.String).annotations({
    description: "The agent participants in the thread",
  }),
  messages: S.Array(S.String).annotations({
    description: "The messages in the thread",
  }),
  parent: S.optional(S.suspend((): S.Schema<Thread> => Thread)),
}) {}
