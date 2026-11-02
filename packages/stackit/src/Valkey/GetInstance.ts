import type * as valkey from "@distilled.cloud/stackit/valkey";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface GetInstanceRequest extends Omit<
  valkey.GetInstanceRequest,
  "projectId" | "regionId" | "instanceId"
> {}

/**
 * Runtime binding for STACKIT Key Value Store `getInstance`: read an instance's status, plan and parameters.
 *
 * Bind this operation to an {@link Instance} in a Function/Worker init phase and
 * provide {@link GetInstanceHttp}. The instance's project, region and id are injected
 * into each request. A foreign host signs with a service account key Alchemy creates
 * for it.
 *
 * Access: a custom role with the single permission `key-value-store.instance.get`, bound on the project
 * holding the instance. STACKIT binds roles on projects at the narrowest, so the
 * permission reaches every Key Value Store instance in that project.
 *
 * ### Calling `getInstance`
 * **Example:** From a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Cache = Stackit.Valkey.Instance("Cache", {
 *   version: "x",
 *   planName: "stackit-keyvalue-1.2.10-replica",
 *   acl: ["203.0.113.7/32"],
 * });
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const instance = yield* Cache;
 *     const getInstance = yield* Stackit.Valkey.GetInstance(instance);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const live = yield* getInstance({});
 *         return yield* HttpServerResponse.json({ status: live.status });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Valkey.GetInstanceHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Valkey
 */
export interface GetInstance extends Binding.Service<
  GetInstance,
  "Stackit.Valkey.GetInstance",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: GetInstanceRequest,
    ) => Effect.Effect<valkey.Instance, valkey.GetInstanceError, RuntimeContext>
  >
> {}

export const GetInstance = Binding.Service<GetInstance>("Stackit.Valkey.GetInstance");
