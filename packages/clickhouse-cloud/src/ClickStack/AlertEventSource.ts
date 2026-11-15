import { sanitizeKey, type RuntimeContext } from "alchemy/RuntimeContext";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { Alert } from "./Alert.ts";

/** One delivery of a ClickStack alert to the host: the JSON ClickStack's generic webhook sends. */
export type AlertNotification = Record<string, unknown>;

/**
 * Run `process` on the host every time a ClickStack alert fires or
 * resolves.
 *
 * At deploy, a generic ClickStack `Webhook` pointing at the host (one path
 * per alert) is created with a generated shared secret in a header, and
 * the alert notifies it in addition to its declared channels. At runtime
 * the host claims that path, rejects deliveries without the secret, and
 * runs `process` once per delivery with the payload ClickStack sends.
 * Needs a host that provides `alchemy/WebhookHost` (a Cloudflare Worker).
 *
 * ### Reacting to Alerts
 * **Example:** Page someone when errors spike
 * ```typescript
 * export default class Pager extends Cloudflare.Worker<Pager>()(
 *   "Pager",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     yield* ClickHouseCloud.ClickStack.consumeAlerts(TooManyErrors, (notification) =>
 *       Effect.log("ClickStack alert", notification),
 *     );
 *     return { fetch: Effect.succeed(HttpServerResponse.text("ok")) };
 *   }).pipe(Effect.provide(ClickHouseCloud.ClickStack.AlertEventSourceLive)),
 * ) {}
 * ```
 *
 * @eventSource
 * @product ClickStack
 */
export const consumeAlerts = <Req = never>(
  alert: Alert,
  process: (notification: AlertNotification) => Effect.Effect<void, never, Req | RuntimeContext>,
): Effect.Effect<void, never, AlertEventSource> =>
  AlertEventSource.use((source) => source(alert, process));

export type AlertEventSourceService = <Req = never>(
  alert: Alert,
  process: (notification: AlertNotification) => Effect.Effect<void, never, Req>,
) => Effect.Effect<void, never, never>;

export class AlertEventSource extends Context.Service<AlertEventSource, AlertEventSourceService>()(
  "ClickHouseCloud.ClickStack.AlertEventSource",
) {}

/** The host path a given alert's deliveries arrive on. */
export const alertPath = (alert: Pick<Alert, "LogicalId">): string =>
  `/__alchemy/clickhouse-cloud/clickstack-alerts/${encodeURIComponent(alert.LogicalId)}`;

/** Env var under which the host holds an alert's webhook secret. */
export const alertSecretEnvName = (alert: Pick<Alert, "LogicalId">): string =>
  `ALCHEMY_CLICKSTACK_ALERT_SECRET_${sanitizeKey(alert.LogicalId)}`;

/** Header carrying the shared secret on every delivery. */
export const ALERT_SECRET_HEADER = "x-alchemy-clickstack-secret";
