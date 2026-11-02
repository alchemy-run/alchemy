import type * as dremio from "@distilled.cloud/stackit/dremio";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface GetInstanceRequest extends Omit<
  dremio.GetDremioInstanceRequest,
  "projectId" | "regionId" | "dremioId"
> {}

/**
 * Runtime binding for STACKIT Dremio `getDremioInstance`: read the instance's settings, endpoints and state.
 *
 * Bind this operation to a {@link Instance} in a Function/Worker init phase and provide
 * {@link GetInstanceHttp}. The instance's project, region and id are injected into each request. A foreign host signs with a service account key Alchemy
 * creates for it.
 *
 * Access: a custom role with `dremio.instance.get`, the permission the API names for this operation, on the
 * project holding the instance. STACKIT binds roles on an organization, folder or project only,
 * so the grant reaches every Dremio instance in that project.
 *
 * ### Reading the Instance
 * **Example:** Read the state from a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Lakehouse = Stackit.Dremio.Instance("Lakehouse", {});
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const lakehouse = yield* Lakehouse;
 *     const getInstance = yield* Stackit.Dremio.GetInstance(lakehouse);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const live = yield* getInstance({});
 *         return yield* HttpServerResponse.json({ state: live.state });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Dremio.GetInstanceHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Dremio
 */
export interface GetInstance extends Binding.Service<
  GetInstance,
  "Stackit.Dremio.GetInstance",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: GetInstanceRequest,
    ) => Effect.Effect<dremio.DremioResponseOutput, dremio.GetDremioInstanceError, RuntimeContext>
  >
> {}

export const GetInstance = Binding.Service<GetInstance>("Stackit.Dremio.GetInstance");
