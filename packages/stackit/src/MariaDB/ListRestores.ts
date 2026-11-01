import type * as mariadb from "@distilled.cloud/stackit/mariadb";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface ListRestoresRequest extends Omit<
  mariadb.ListRestoresRequest,
  "projectId" | "regionId" | "instanceId"
> {}

/**
 * Runtime binding for STACKIT MariaDB `listRestores`: list the instance's restores.
 *
 * Bind this operation to an {@link Instance} in a Function/Worker init phase and
 * provide {@link ListRestoresHttp}. The instance's project, region and id are injected
 * into each request. A foreign host signs with a service account key Alchemy creates
 * for it.
 *
 * Access: a custom role with the single permission `mariadb.proxy.read`, bound on the project
 * holding the instance. STACKIT binds roles on projects at the narrowest, so the
 * permission reaches every MariaDB instance in that project.
 * STACKIT gates backups, metrics, restarts and updates behind this one permission, so it
 * allows all of the reads in that group.
 *
 * ### Calling `listRestores`
 * **Example:** From a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Db = Stackit.MariaDB.Instance("Db", {
 *   version: "10.11",
 *   planName: "stackit-mariadb-1.2.10-replica",
 *   acl: ["203.0.113.7/32"],
 * });
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const instance = yield* Db;
 *     const listRestores = yield* Stackit.MariaDB.ListRestores(instance);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const restores = yield* listRestores({});
 *         return yield* HttpServerResponse.json({ count: restores.instanceRestores.length });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.MariaDB.ListRestoresHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category MariaDB
 */
export interface ListRestores extends Binding.Service<
  ListRestores,
  "Stackit.MariaDB.ListRestores",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: ListRestoresRequest,
    ) => Effect.Effect<mariadb.ListRestoresResponse, mariadb.ListRestoresError, RuntimeContext>
  >
> {}

export const ListRestores = Binding.Service<ListRestores>("Stackit.MariaDB.ListRestores");
