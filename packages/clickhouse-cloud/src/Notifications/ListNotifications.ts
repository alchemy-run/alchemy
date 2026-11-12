import type * as notifications from "@distilled.cloud/clickhouse-cloud/notifications";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Organization } from "../Organization/Organization.ts";

/** Filters on the notification feed. Every one is optional. */
export interface ListNotificationsRequest {
  /** `info`, `warning` or `critical`. */
  severity?: "info" | "warning" | "critical";
  /** A notification type, as `ListNotificationTypes` names it. */
  type?: string;
  /** Notifications about one resource; a service also matches its ClickPipes. */
  resourceId?: string;
  /** `service`, `organization`, `clickpipe` or `postgres`. */
  resourceType?: string;
  /** Created at or after this RFC 3339 timestamp. */
  fromDate?: string;
  /** Created at or before this RFC 3339 timestamp. */
  toDate?: string;
}

/**
 * Read the organization's notification feed at runtime (kept 180 days),
 * newest first, every page of it: scaling events, billing thresholds,
 * ClickPipe failures, …. Use it to forward notifications to your own
 * channels. The endpoint is in public beta.
 *
 * The host gets its own API key, with a role that allows only
 * `control-plane:organization:view` on the organization. The API returns
 * only notifications about resources the caller can see, so the feed holds
 * the organization's own notifications (billing, quotas), not those of
 * services the key has no role on. ClickHouse Cloud federates no workload
 * identity, so a key is the only way in.
 *
 * ### Reading Notifications
 * **Example:** Critical notifications of the last day
 * ```typescript
 * export const Org = ClickHouseCloud.Organization.Organization("Org", {});
 *
 * export default class Alerts extends Cloudflare.Worker<Alerts>()(
 *   "Alerts",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const listNotifications = yield* ClickHouseCloud.Notifications.ListNotifications(Org);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const since = new Date(Date.now() - 86_400_000).toISOString();
 *         // runtime
 *         const feed = yield* listNotifications({ severity: "critical", fromDate: since });
 *         return yield* HttpServerResponse.json(feed.map((n) => n.title));
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(ClickHouseCloud.Notifications.ListNotificationsHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product Notifications
 */
export interface ListNotifications extends Binding.Service<
  ListNotifications,
  "ClickHouseCloud.Notifications.ListNotifications",
  (
    target: Organization,
  ) => Effect.Effect<
    (
      request?: ListNotificationsRequest,
    ) => Effect.Effect<
      notifications.Notification[],
      notifications.ListNotificationsError,
      RuntimeContext
    >
  >
> {}

export const ListNotifications = Binding.Service<ListNotifications>(
  "ClickHouseCloud.Notifications.ListNotifications",
);
