import type * as logs from "@distilled.cloud/stackit/logs";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface ListInstancesRequest extends Omit<
  logs.ListLogsInstancesRequest,
  "projectId" | "regionId"
> {}

/**
 * Runtime binding for Logs `listLogsInstances`: list every Logs instance in a project
 * and region, for discovery. The API returns the whole list. The bound instance only
 * names the project and region.
 *
 * Bind this operation to any {@link Instance} in that project and region in a
 * Function/Worker init phase and provide {@link ListInstancesHttp}. A foreign host
 * signs with a service account key Alchemy creates for it.
 *
 * Access: a custom role holding only `logs.instance.list`, on the project holding the
 * instance. STACKIT binds roles on projects, folders and organizations, never on one
 * instance, so the role reaches every Logs instance in the project. The deployer needs
 * `iam.role.add` on the project to define it.
 *
 * ### Listing Instances
 * **Example:** List a project's instances from a Cloudflare Worker
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
 *     const listInstances = yield* Stackit.Logs.ListInstances(yield* Logs);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const result = yield* listInstances({});
 *         return yield* HttpServerResponse.json({ names: result.instances.map((instance) => instance.displayName) });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Logs.ListInstancesHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT Logs
 * @category Logs
 */
export interface ListInstances extends Binding.Service<
  ListInstances,
  "Stackit.Logs.ListInstances",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request?: ListInstancesRequest,
    ) => Effect.Effect<logs.LogsInstancesList, logs.ListLogsInstancesError, RuntimeContext>
  >
> {}

export const ListInstances = Binding.Service<ListInstances>("Stackit.Logs.ListInstances");
