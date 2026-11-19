import * as Domain from "@alchemy.run/domain";
import * as Layer from "effect/Layer";
import { ChannelBoard, ChannelBoardLive } from "./Channel/ChannelBoard.view.ts";
import { Dependencies, DependenciesLive } from "./Task/Dependencies.policy.ts";
import { Leases, LeasesLive } from "./Task/Leases.policy.ts";
import { ReadyTasks, ReadyTasksLive } from "./Task/ReadyTasks.query.ts";
import { FollowUps, FollowUpsLive } from "./Thread/FollowUps.policy.ts";
import { Thread } from "./Thread/Thread.aggregate.ts";
import { ThreadSummary, ThreadSummaryLive } from "./Thread/ThreadSummary.view.ts";
import { ThreadTimeline, ThreadTimelineLive } from "./Thread/ThreadTimeline.view.ts";

/**
 * A board where people and agents coordinate work: threads in channels,
 * tasks with leases and dependencies, and follow-ups posted later.
 */
export class Board extends Domain.Model("Board", {
  aggregates: [Thread],
  views: [ThreadSummary, ThreadTimeline, ChannelBoard],
  policies: [Leases, Dependencies, FollowUps],
  queries: [ReadyTasks],
}) {}

/** Every policy and query implementation, and who may read each view. */
export const BoardHandlers = Layer.mergeAll(
  ThreadSummaryLive,
  ThreadTimelineLive,
  ChannelBoardLive,
  LeasesLive,
  DependenciesLive,
  FollowUpsLive,
  ReadyTasksLive,
);
