import type * as organization from "@distilled.cloud/clickhouse-cloud/organization";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { ResultMissing } from "../Errors.ts";
import type { Organization } from "./Organization.ts";

/** A time window of the audit log. */
export interface ListActivitiesRequest {
  /** Start of the window (ISO 8601). */
  fromDate?: string;
  /** End of the window (ISO 8601). */
  toDate?: string;
}

/**
 * List the organization's audit log at runtime: who created, changed or
 * deleted services, keys, roles and members, and when. Use it to export
 * the audit log to your own storage.
 *
 * The host gets its own API key, with a role that allows only
 * `control-plane:organization:view` and
 * `control-plane:organization:view-activities` on the organization. ClickHouse Cloud
 * federates no workload identity, so a key is the only way in.
 *
 * ### Reading the Audit Log
 * **Example:** Export the last day of activity
 * ```typescript
 * export const Org = ClickHouseCloud.Organization.Organization("Org", {});
 *
 * export default class Audit extends Cloudflare.Worker<Audit>()(
 *   "Audit",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     // init: grants control-plane:organization:view and :view-activities
 *     const listActivities = yield* ClickHouseCloud.Organization.ListActivities(Org);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime
 *         const since = new Date(Date.now() - 86_400_000).toISOString();
 *         const activities = yield* listActivities({ fromDate: since });
 *         return yield* HttpServerResponse.json(activities);
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(ClickHouseCloud.Organization.ListActivitiesHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product Organization
 */
export interface ListActivities extends Binding.Service<
  ListActivities,
  "ClickHouseCloud.Organization.ListActivities",
  (
    target: Organization,
  ) => Effect.Effect<
    (
      request?: ListActivitiesRequest,
    ) => Effect.Effect<
      organization.Activity[],
      organization.ListActivitiesError | ResultMissing,
      RuntimeContext
    >
  >
> {}

export const ListActivities = Binding.Service<ListActivities>(
  "ClickHouseCloud.Organization.ListActivities",
);
