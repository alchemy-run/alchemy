import * as Domain from "@alchemy.run/domain";
import { Board } from "./Board.model.ts";

/**
 * What people and agents reach, over the typed client, MCP and the CLI. The
 * commands the board sends itself (lease expiry, dependency tracking,
 * follow-up delivery) are not served.
 */
export class BoardApi extends Domain.Api(
  "BoardApi",
  {
    model: Board,
    commands: [
      "StartThread",
      "CreateTask",
      "PostMessage",
      "LabelThread",
      "ScheduleFollowUp",
      "ClaimTask",
      "RenewLease",
      "CompleteTask",
      "ReleaseTask",
    ],
    views: ["ThreadSummary", "ThreadTimeline", "ChannelBoard"],
    queries: ["ReadyTasks"],
  },
  {
    description: "A board where people and agents coordinate work in channels, threads and tasks.",
  },
) {}

/** Every call that returns once, as the MCP server and the CLI expose them. */
export const exposed = [
  "StartThread",
  "CreateTask",
  "PostMessage",
  "LabelThread",
  "ScheduleFollowUp",
  "ClaimTask",
  "RenewLease",
  "CompleteTask",
  "ReleaseTask",
  "ReadyTasks",
  "ThreadSummary.get",
  "ThreadTimeline.list",
  "ChannelBoard.get",
] as const;
