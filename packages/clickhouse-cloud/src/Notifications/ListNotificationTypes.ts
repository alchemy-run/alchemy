import type * as notifications from "@distilled.cloud/clickhouse-cloud/notifications";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { ResultMissing } from "../Errors.ts";
import type { Organization } from "../Organization/Organization.ts";

/**
 * Read the notification types the organization can receive at runtime,
 * each with its category, severity and whether the caller may see it
 * (`isAvailable`). Use it to build filters for `ListNotifications`. The
 * endpoint is in public beta.
 *
 * The host gets its own API key, with a role that allows only
 * `control-plane:organization:view` on the organization. ClickHouse Cloud
 * federates no workload identity, so a key is the only way in.
 *
 * ### Reading Notification Types
 * **Example:** The critical types
 * ```typescript
 * export const Org = ClickHouseCloud.Organization.Organization("Org", {});
 *
 * export default class Types extends Cloudflare.Worker<Types>()(
 *   "Types",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const listTypes = yield* ClickHouseCloud.Notifications.ListNotificationTypes(Org);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime
 *         const types = yield* listTypes();
 *         return yield* HttpServerResponse.json(
 *           types.filter((t) => t.severity === "critical").map((t) => t.name),
 *         );
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(ClickHouseCloud.Notifications.ListNotificationTypesHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product Notifications
 */
export interface ListNotificationTypes extends Binding.Service<
  ListNotificationTypes,
  "ClickHouseCloud.Notifications.ListNotificationTypes",
  (
    target: Organization,
  ) => Effect.Effect<
    () => Effect.Effect<
      notifications.NotificationType[],
      notifications.ListNotificationTypesError | ResultMissing,
      RuntimeContext
    >
  >
> {}

export const ListNotificationTypes = Binding.Service<ListNotificationTypes>(
  "ClickHouseCloud.Notifications.ListNotificationTypes",
);
