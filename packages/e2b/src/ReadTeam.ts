import type * as auth from "@distilled.cloud/e2b/auth";
import type * as events from "@distilled.cloud/e2b/events";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { E2BError } from "./SandboxClient.ts";

/** Team usage and the sandbox lifecycle event log. */
export interface TeamClient {
  /** The team's id: the deployer's team, which the host's key belongs to. */
  readonly teamId: Effect.Effect<string, never, RuntimeContext>;
  /** Concurrent sandboxes and sandbox start rate over time (unix seconds). */
  metrics(
    options?: Omit<auth.ListTeamMetricsRequest, "teamID">,
  ): Effect.Effect<auth.ListTeamMetricsResponse, E2BError, RuntimeContext>;
  /** The peak of one metric over a window. */
  maxMetric(
    options: Omit<auth.GetTeamMetricsMaxRequest, "teamID">,
  ): Effect.Effect<auth.MaxTeamMetric, E2BError, RuntimeContext>;
  /** Lifecycle events of every sandbox in the team, newest first by default. */
  events(
    options?: events.ListTeamSandboxEventsRequest,
  ): Effect.Effect<events.ListTeamSandboxEventsResponse, E2BError, RuntimeContext>;
  /** Lifecycle events of one sandbox. */
  sandboxEvents(
    sandboxId: string,
    options?: Omit<events.ListSandboxEventsRequest, "sandboxID">,
  ): Effect.Effect<events.ListSandboxEventsResponse, E2BError, RuntimeContext>;
}

/**
 * Read the team's sandbox usage and lifecycle event log: dashboards, quotas,
 * auditing which sandboxes started, paused and were killed.
 *
 * To react to lifecycle events as they happen, use `E2B.SandboxEvents`.
 *
 * ### Reading usage
 * **Example:** Concurrent sandboxes over the last hour
 * ```typescript
 * const team = yield* E2B.ReadTeam();
 * // in fetch:
 * const now = Math.floor(Date.now() / 1000);
 * const metrics = yield* team.metrics({ start: now - 3600, end: now });
 * ```
 *
 * @binding
 * @product Team
 */
export interface ReadTeam extends Binding.Service<
  ReadTeam,
  "E2B.ReadTeam",
  () => Effect.Effect<TeamClient>
> {}

export const ReadTeam = Binding.Service<ReadTeam>("E2B.ReadTeam");
