import type * as intake from "@distilled.cloud/stackit/intake";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Runner } from "./Runner.ts";

export interface GetRunnerRequest extends Omit<
  intake.GetIntakeRunnerRequest,
  "projectId" | "regionId" | "intakeRunnerId"
> {}

/**
 * Runtime binding for Intake `getIntakeRunner`: read a runner's Kafka endpoint,
 * capacity and state.
 *
 * Bind this operation to a {@link Runner} in a Function/Worker init phase and
 * provide {@link GetRunnerHttp}. It works on any host. A foreign host signs with a
 * service account key Alchemy creates for it.
 *
 * Access: a custom role holding only `intake.intake.get` on the project of the bound
 * resource, the narrowest scope STACKIT binds roles on, so it reaches that whole
 * project. The deployer needs `iam.role.add` on that scope to define the role. The
 * spec uses this one action for runners, intakes and users alike.
 *
 * ### Reading the Runner
 * **Example:** Read the runner from a Cloudflare Worker
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
 *     const getRunner = yield* Stackit.Intake.GetRunner(bound);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const live = yield* getRunner({});
 *         return yield* HttpServerResponse.json({ uri: live.uri, state: live.state });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Intake.GetRunnerHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT Intake
 * @category Intake
 */
export interface GetRunner extends Binding.Service<
  GetRunner,
  "Stackit.Intake.GetRunner",
  (
    runner: Runner,
  ) => Effect.Effect<
    (
      request: GetRunnerRequest,
    ) => Effect.Effect<intake.IntakeRunnerResponse, intake.GetIntakeRunnerError, RuntimeContext>
  >
> {}

export const GetRunner = Binding.Service<GetRunner>("Stackit.Intake.GetRunner");
