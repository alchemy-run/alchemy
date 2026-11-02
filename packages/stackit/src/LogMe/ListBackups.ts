import type * as logme from "@distilled.cloud/stackit/logme";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface ListBackupsRequest extends Omit<
  logme.ListBackupsRequest,
  "projectId" | "regionId" | "instanceId"
> {}

/**
 * Runtime binding for STACKIT LogMe `listBackups`: list the instance's backups.
 *
 * Bind this operation to an {@link Instance} in a Function/Worker init phase and
 * provide {@link ListBackupsHttp}. The instance's project, region and id are injected
 * into each request. A foreign host signs with a service account key Alchemy creates
 * for it.
 *
 * Access: a custom role with the single permission `logme.proxy.read`, bound on the
 * project holding the instance. STACKIT binds roles on projects at the narrowest, so
 * the permission reaches every STACKIT LogMe instance in that project. STACKIT gates
 * backups, metrics, restarts and updates behind this one permission, so it allows all
 * of the reads in that group.
 *
 * ### Calling `listBackups`
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
 *     const listBackups = yield* Stackit.LogMe.ListBackups(instance);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const backups = yield* listBackups({});
 *         return yield* HttpServerResponse.json({ count: backups.length });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.LogMe.ListBackupsHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category LogMe
 */
export interface ListBackups extends Binding.Service<
  ListBackups,
  "Stackit.LogMe.ListBackups",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: ListBackupsRequest,
    ) => Effect.Effect<logme.ListBackupsResponse2, logme.ListBackupsError, RuntimeContext>
  >
> {}

export const ListBackups = Binding.Service<ListBackups>("Stackit.LogMe.ListBackups");
