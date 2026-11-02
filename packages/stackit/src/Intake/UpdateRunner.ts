import type * as intake from "@distilled.cloud/stackit/intake";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Runner } from "./Runner.ts";

export interface UpdateRunnerRequest extends Omit<
  intake.UpdateIntakeRunnerRequest,
  "projectId" | "regionId" | "intakeRunnerId"
> {}

/**
 * Runtime binding for Intake `updateIntakeRunner`: change a runner from a running
 * host, typically to raise its capacity under load. STACKIT only takes a capacity
 * whose product of the two limits grows, and bills the larger reservation from then
 * on. The stack keeps its own props: a later deploy that updates this runner sets
 * the capacity back to them, which the API refuses when that is lower, so raise the
 * props too.
 *
 * Bind this operation to a {@link Runner} in a Function/Worker init phase and
 * provide {@link UpdateRunnerHttp}. It works on any host. A foreign host signs with
 * a service account key Alchemy creates for it.
 *
 * Access: a custom role holding only `intake.intake.update` on the project of the
 * bound resource, the narrowest scope STACKIT binds roles on, so it reaches that
 * whole project. The deployer needs `iam.role.add` on that scope to define the role.
 * The spec uses this one action for runners, intakes and users alike.
 *
 * ### Raising Capacity
 * **Example:** Double a runner's message rate from a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Ingest = Stackit.Intake.Runner("Ingest", {
 *   maxMessageSizeKiB: 1024,
 *   maxMessagesPerHour: 1024,
 * });
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const bound = yield* Ingest;
 *     const updateRunner = yield* Stackit.Intake.UpdateRunner(bound);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const live = yield* updateRunner({ maxMessagesPerHour: 2048 });
 *         return yield* HttpServerResponse.json({ state: live.state });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Intake.UpdateRunnerHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT Intake
 * @category Intake
 */
export interface UpdateRunner extends Binding.Service<
  UpdateRunner,
  "Stackit.Intake.UpdateRunner",
  (
    runner: Runner,
  ) => Effect.Effect<
    (
      request: UpdateRunnerRequest,
    ) => Effect.Effect<intake.IntakeRunnerResponse, intake.UpdateIntakeRunnerError, RuntimeContext>
  >
> {}

export const UpdateRunner = Binding.Service<UpdateRunner>("Stackit.Intake.UpdateRunner");
