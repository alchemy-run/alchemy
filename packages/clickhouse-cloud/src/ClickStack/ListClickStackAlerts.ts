import type * as stack from "@distilled.cloud/clickhouse-cloud/click_stack";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { ResultMissing } from "../Errors.ts";
import type { Service } from "../Service/Service.ts";

/** Filters on the alert list; `limit`/`offset` page through it (at most 1000 a page). */
export type ListClickStackAlertsRequest = Omit<
  stack.ListClickStackAlertsRequest,
  "organizationId" | "serviceId"
>;

/**
 * List a service's ClickStack alerts at runtime, filtered by `state`,
 * `tag`, `source` or a `search` string: "what is firing now". The endpoint
 * is in beta.
 *
 * The host gets its own API key, with a role that allows only
 * `control-plane:service:view` and
 * `control-plane:service:manage-clickstack-api` on the bound service (the
 * ClickStack API has no read-only permission). ClickHouse Cloud federates
 * no workload identity, so a key is the only way in.
 *
 * ### Listing Firing Alerts
 * **Example:** A status page
 * ```typescript
 * export default class Status extends Cloudflare.Worker<Status>()(
 *   "Status",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const listAlerts = yield* ClickHouseCloud.ClickStack.ListClickStackAlerts(Analytics);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime
 *         const firing = yield* listAlerts({ state: ["ALERT"] });
 *         return yield* HttpServerResponse.json(firing.map((a) => a.name));
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(ClickHouseCloud.ClickStack.ListClickStackAlertsHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product ClickStack
 */
export interface ListClickStackAlerts extends Binding.Service<
  ListClickStackAlerts,
  "ClickHouseCloud.ClickStack.ListClickStackAlerts",
  (
    target: Service,
  ) => Effect.Effect<
    (
      request?: ListClickStackAlertsRequest,
    ) => Effect.Effect<
      stack.ClickStackAlertResponse[],
      stack.ListClickStackAlertsError | ResultMissing,
      RuntimeContext
    >
  >
> {}

export const ListClickStackAlerts = Binding.Service<ListClickStackAlerts>(
  "ClickHouseCloud.ClickStack.ListClickStackAlerts",
);
