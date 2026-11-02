import type * as mongodb from "@distilled.cloud/stackit/mongodb_flex";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface ListAdvisorSlowQueriesRequest extends Omit<
  mongodb.ListAdvisorSlowQueriesRequest,
  "projectId" | "region" | "instanceId"
> {}

/**
 * Runtime binding for MongoDB Flex `listAdvisorSlowQueries`: list the slow queries the Performance Advisor detected on the instance.
 *
 * Bind this operation to an {@link Instance} in a Function/Worker init phase and
 * provide {@link ListAdvisorSlowQueriesHttp}. The instance's project, region and id are injected
 * into each request. A foreign host signs with a service account key Alchemy creates
 * for it.
 *
 * Access: a custom role with the single permission `mongodb-flex.advisor.list`, bound on the project
 * holding the instance. STACKIT binds roles on projects at the narrowest, so the
 * permission reaches every MongoDB Flex instance in that project.
 *
 * ### Calling `listAdvisorSlowQueries`
 * **Example:** From a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Db = Stackit.MongoDBFlex.Instance("Db", {
 *   flavorId: "2.4",
 *   version: "7.0",
 *   replicas: 3,
 *   type: "Replica",
 *   storage: { class: "premium-perf2-mongodb", size: 10 },
 *   acl: ["203.0.113.7/32"],
 *   backupSchedule: "0 2 * * *",
 * });
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const db = yield* Db;
 *     const listAdvisorSlowQueries = yield* Stackit.MongoDBFlex.ListAdvisorSlowQueries(db);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { slowQueries } = yield* listAdvisorSlowQueries({});
 *         return yield* HttpServerResponse.json({ count: slowQueries?.length ?? 0 });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.MongoDBFlex.ListAdvisorSlowQueriesHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category MongoDBFlex
 */
export interface ListAdvisorSlowQueries extends Binding.Service<
  ListAdvisorSlowQueries,
  "Stackit.MongoDBFlex.ListAdvisorSlowQueries",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: ListAdvisorSlowQueriesRequest,
    ) => Effect.Effect<
      mongodb.HandlersInstancesSlowQueriesResponse,
      mongodb.ListAdvisorSlowQueriesError,
      RuntimeContext
    >
  >
> {}

export const ListAdvisorSlowQueries = Binding.Service<ListAdvisorSlowQueries>(
  "Stackit.MongoDBFlex.ListAdvisorSlowQueries",
);
