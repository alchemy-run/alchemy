import type * as mariadb from "@distilled.cloud/stackit/mariadb";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface GetMetricsRequest extends Omit<
  mariadb.GetMetricsRequest,
  "projectId" | "regionId" | "instanceId"
> {}

/**
 * Runtime binding for STACKIT MariaDB `getMetrics`: read the instance's latest CPU, memory and disk metrics.
 *
 * Bind this operation to an {@link Instance} in a Function/Worker init phase and
 * provide {@link GetMetricsHttp}. The instance's project, region and id are injected
 * into each request. A foreign host signs with a service account key Alchemy creates
 * for it.
 *
 * Access: a custom role with the single permission `mariadb.proxy.read`, bound on the project
 * holding the instance. STACKIT binds roles on projects at the narrowest, so the
 * permission reaches every MariaDB instance in that project.
 * STACKIT gates backups, metrics, restarts and updates behind this one permission, so it
 * allows all of the reads in that group.
 *
 * ### Calling `getMetrics`
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
 *     const getMetrics = yield* Stackit.MariaDB.GetMetrics(instance);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const metrics = yield* getMetrics({});
 *         return yield* HttpServerResponse.json({ load: metrics.load1 });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.MariaDB.GetMetricsHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category MariaDB
 */
export interface GetMetrics extends Binding.Service<
  GetMetrics,
  "Stackit.MariaDB.GetMetrics",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: GetMetricsRequest,
    ) => Effect.Effect<mariadb.GetMetricsResponse, mariadb.GetMetricsError, RuntimeContext>
  >
> {}

export const GetMetrics = Binding.Service<GetMetrics>("Stackit.MariaDB.GetMetrics");
