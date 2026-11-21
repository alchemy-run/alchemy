import * as Domain from "@alchemy.run/domain";
import { TaskStatus } from "./TaskStatus.ts";

/** Only the actor holding a task's claim may renew, complete or release it. */
export class NotYourClaim extends Domain.Rejection(
  "NotYourClaim",
  { status: TaskStatus },
  {
    httpApiStatus: 409,
    description: "Only the actor holding the task's claim may renew, complete or release it.",
  },
) {}
