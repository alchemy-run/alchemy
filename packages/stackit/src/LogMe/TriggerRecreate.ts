import type * as logme from "@distilled.cloud/stackit/logme";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface TriggerRecreateRequest extends Omit<
  logme.TriggerRecreateRequest,
  "projectId" | "regionId" | "instanceId"
> {}

/**
 * Runtime binding for STACKIT LogMe `triggerRecreate`: recreate the instance's VMs, to
 * recover it.
 *
 * Bind this operation to an {@link Instance} in a Function/Worker init phase and
 * provide {@link TriggerRecreateHttp}. The instance's project, region and id are injected
 * into each request. A foreign host signs with a service account key Alchemy creates
 * for it.
 *
 * Access: a custom role with the single permission `logme.proxy.write`, bound on the
 * project holding the instance. STACKIT binds roles on projects at the narrowest, so
 * the permission reaches every STACKIT LogMe instance in that project. STACKIT gates
 * backups, metrics, restarts and updates behind this one permission, so it allows all
 * of the changes in that group.
 *
 * ### Calling `triggerRecreate`
 * **Example:** From a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Logs = Stackit.LogMe.Instance("Logs", {
 *   version: "2",
 *   planName: "stackit-logme2-1.2.50-replica",
 *   acl: ["203.0.113.7/32"],
 * });
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const instance = yield* Logs;
 *     const triggerRecreate = yield* Stackit.LogMe.TriggerRecreate(instance);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { instanceId } = yield* triggerRecreate({});
 *         return yield* HttpServerResponse.json({ instanceId });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.LogMe.TriggerRecreateHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category LogMe
 */
export interface TriggerRecreate extends Binding.Service<
  TriggerRecreate,
  "Stackit.LogMe.TriggerRecreate",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: TriggerRecreateRequest,
    ) => Effect.Effect<logme.CreateInstanceResponse, logme.TriggerRecreateError, RuntimeContext>
  >
> {}

export const TriggerRecreate = Binding.Service<TriggerRecreate>("Stackit.LogMe.TriggerRecreate");
