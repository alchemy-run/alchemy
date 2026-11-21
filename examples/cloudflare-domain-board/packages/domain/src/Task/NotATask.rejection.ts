import * as Domain from "@alchemy.run/domain";

/** The thread is a conversation, not a task. */
export class NotATask extends Domain.Rejection(
  "NotATask",
  {},
  { httpApiStatus: 409, description: "The thread is a conversation, not a task." },
) {}
