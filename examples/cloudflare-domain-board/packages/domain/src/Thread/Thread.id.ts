import * as Schema from "effect/Schema";

/** A thread on the board: a conversation, which may also be a task. */
export const ThreadId = Schema.String.pipe(Schema.brand("ThreadId")).annotate({
  description: "The thread's id, chosen by whoever starts it",
});
export type ThreadId = typeof ThreadId.Type;
