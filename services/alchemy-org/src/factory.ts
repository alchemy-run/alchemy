/**
 * The factory, composed once — ENVIRONMENT-AGNOSTIC. Two processes,
 * each with its one generic implementation, under one budget.
 *
 * Deliberately NOT baked in here:
 *
 * - the agents (Engineer/Reviewer): their TOOL physics is
 *   per-environment (local toolbox vs DevBox container), so the
 *   entrypoints provide `EngineerLocal` / `EngineerCloudflare`;
 * - the seams (arrival, ledger, kernel, credentials): the environment
 *   IS the provide-list — see local.ts and worker.ts.
 */
import * as AI from "alchemy/AI";
import * as Layer from "effect/Layer";
import { GitHubIssuesLive } from "./issues.ts";
import { GitHubPullRequestsLive } from "./pull-requests.ts";

/**
 * The org: both processes under one budget. Requirements left OPEN
 * (the seams): kernel, ledger, arrival, credentials, agents, tools.
 *
 * No event channel, no bus: the drive loops in issues.ts /
 * pull-requests.ts are the factory's one wire consumer, and they
 * DELIVER exits to their runs directly (`settle(key, event)`) — the
 * kernel subscribes to nothing.
 */
export const Factory = Layer.mergeAll(
  GitHubIssuesLive,
  GitHubPullRequestsLive,
).pipe(
  // budget is NOT prose (owner ruling): ceilings are provided where
  // the terms are provided — exhaustion stays a typed BudgetExceeded
  Layer.provide(AI.budget({ tokens: "10M", wallClock: "72h" })),
);
