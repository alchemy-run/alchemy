import type * as git from "@distilled.cloud/stackit/git";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Runner } from "./Runner.ts";

export interface GetRunnerRequest extends Omit<git.GetRunnerRequest, "projectId" | "instanceId"> {}

/**
 * Runtime binding for STACKIT Git `getRunner`: read the status and labels of an instance's runner.
 *
 * Bind this operation to a {@link Runner} in a Function/Worker init phase
 * and provide {@link GetRunnerHttp}. The runner's project and instance are injected into each request.
 * A foreign host signs with a service account key Alchemy creates for it.
 *
 * Access: a custom role with `git.runner.get`, the permission the spec names for this operation, on
 * the project holding the instance, because STACKIT binds roles on nothing narrower than a project.
 * It reaches every instance in that project.
 *
 * ### Reading the Runner
 * **Example:** Report the runner's status from a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Ci = Effect.gen(function* () {
 *   const forge = yield* Stackit.Git.Instance("Forge", {});
 *   return yield* Stackit.Git.Runner("Ci", {
 *     instanceId: forge.instanceId,
 *     labels: ["stackit-docker"],
 *   });
 * });
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const getRunner = yield* Stackit.Git.GetRunner(yield* Ci);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const runner = yield* getRunner({});
 *         return yield* HttpServerResponse.json({ status: runner.status });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Git.GetRunnerHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT Git
 * @category Git
 */
export interface GetRunner extends Binding.Service<
  GetRunner,
  "Stackit.Git.GetRunner",
  (
    runner: Runner,
  ) => Effect.Effect<
    (request: GetRunnerRequest) => Effect.Effect<git.Runner, git.GetRunnerError, RuntimeContext>
  >
> {}

export const GetRunner = Binding.Service<GetRunner>("Stackit.Git.GetRunner");
