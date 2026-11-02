import type * as logs from "@distilled.cloud/stackit/logs";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface GetInstanceRequest extends Omit<
  logs.GetLogsInstanceRequest,
  "projectId" | "regionId" | "instanceId"
> {}

/**
 * Runtime binding for Logs `getLogsInstance`: read the instance's status, settings and
 * URLs. The instance's project, region and id are injected into each request.
 *
 * Bind this operation to an {@link Instance} in a Function/Worker init phase and
 * provide {@link GetInstanceHttp}. A foreign host signs with a service account key
 * Alchemy creates for it.
 *
 * Access: a custom role holding only `logs.instance.get`, on the project holding the
 * instance. STACKIT binds roles on projects, folders and organizations, never on one
 * instance, so the role reaches every Logs instance in the project. The deployer needs
 * `iam.role.add` on the project to define it.
 *
 * ### Reading the Instance
 * **Example:** Read the status and URLs from a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Logs = Stackit.Logs.Instance("Logs", { acl: ["0.0.0.0/0"] });
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const getInstance = yield* Stackit.Logs.GetInstance(yield* Logs);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const result = yield* getInstance({});
 *         return yield* HttpServerResponse.json({ status: result.status, queryUrl: result.queryUrl });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Logs.GetInstanceHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT Logs
 * @category Logs
 */
export interface GetInstance extends Binding.Service<
  GetInstance,
  "Stackit.Logs.GetInstance",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request?: GetInstanceRequest,
    ) => Effect.Effect<logs.LogsInstance, logs.GetLogsInstanceError, RuntimeContext>
  >
> {}

export const GetInstance = Binding.Service<GetInstance>("Stackit.Logs.GetInstance");
