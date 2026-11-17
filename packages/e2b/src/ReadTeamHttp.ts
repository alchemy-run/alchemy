import * as auth from "@distilled.cloud/e2b/auth";
import * as events from "@distilled.cloud/e2b/events";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { bindE2B } from "./E2BBindings.ts";
import { ReadTeam, type TeamClient } from "./ReadTeam.ts";

/**
 * HTTP implementation of {@link ReadTeam}. Works on any host.
 *
 * ### Provide the layer
 * **Example:** On a Worker
 * ```typescript
 * Effect.gen(function* () {
 *   const team = yield* E2B.ReadTeam();
 *   // ...
 * }).pipe(Effect.provide(E2B.ReadTeamHttp))
 * ```
 *
 * @layer
 * @product Team
 * @provides E2B.ReadTeam
 */
export const ReadTeamHttp = Layer.succeed(
  ReadTeam,
  Effect.fn("E2B.ReadTeam")(function* () {
    const e2b = yield* bindE2B;
    const client: TeamClient = {
      teamId: e2b.teamId,
      metrics: Effect.fn("E2B.ReadTeam.metrics")(function* (options) {
        const teamID = yield* e2b.teamId;
        return yield* e2b.authorize(auth.listTeamMetrics({ ...options, teamID }));
      }),
      maxMetric: Effect.fn("E2B.ReadTeam.maxMetric")(function* (options) {
        const teamID = yield* e2b.teamId;
        return yield* e2b.authorize(auth.getTeamMetricsMax({ ...options, teamID }));
      }),
      events: (options) => e2b.authorize(events.listTeamSandboxEvents({ ...options })),
      sandboxEvents: (sandboxId, options) =>
        e2b.authorize(events.listSandboxEvents({ ...options, sandboxID: sandboxId })),
    };
    return client;
  }),
);
