import type * as alertmanager from "@distilled.cloud/stackit/observability_alertmanager";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Credential } from "./Credential.ts";
import type { Instance } from "./Instance.ts";

/** The Alertmanager API v2 of a bound instance. */
export interface AlertsClient {
  /** Read Alertmanager's status, version and configuration. */
  getStatus: () => Effect.Effect<
    alertmanager.AlertmanagerStatus,
    alertmanager.GetStatusError,
    RuntimeContext
  >;
  /** List the configured receivers. */
  getReceivers: () => Effect.Effect<
    alertmanager.GetReceiversResponse,
    alertmanager.GetReceiversError,
    RuntimeContext
  >;
  /** List the current alerts. */
  getAlerts: (
    request?: alertmanager.GetAlertsRequest,
  ) => Effect.Effect<alertmanager.GetAlertsResponse, alertmanager.GetAlertsError, RuntimeContext>;
  /** List the current alerts, grouped as they would be sent. */
  getAlertGroups: (
    request?: alertmanager.GetAlertGroupsRequest,
  ) => Effect.Effect<
    alertmanager.GetAlertGroupsResponse,
    alertmanager.GetAlertGroupsError,
    RuntimeContext
  >;
  /** Fire alerts, or resolve them by setting `endsAt` in the past. */
  createAlerts: (
    request: alertmanager.CreateAlertRequest,
  ) => Effect.Effect<
    alertmanager.CreateAlertResponse,
    alertmanager.CreateAlertError,
    RuntimeContext
  >;
  /** List the silences. */
  getSilences: (
    request?: alertmanager.GetSilencesRequest,
  ) => Effect.Effect<
    alertmanager.GetSilencesResponse,
    alertmanager.GetSilencesError,
    RuntimeContext
  >;
  /** Read one silence. */
  getSilence: (
    request: alertmanager.GetSilenceRequest,
  ) => Effect.Effect<alertmanager.GettableSilence, alertmanager.GetSilenceError, RuntimeContext>;
  /** Create a silence, or update the one whose `id` it carries. */
  createSilence: (
    request: alertmanager.CreateSilenceRequest,
  ) => Effect.Effect<
    alertmanager.CreateSilenceResponse,
    alertmanager.CreateSilenceError,
    RuntimeContext
  >;
  /** Expire a silence. */
  deleteSilence: (
    request: alertmanager.DeleteSilenceRequest,
  ) => Effect.Effect<
    alertmanager.DeleteSilenceResponse,
    alertmanager.DeleteSilenceError,
    RuntimeContext
  >;
}

/**
 * Bind an {@link Instance} and a {@link Credential} to the instance's Alertmanager API v2,
 * on its `alertingUrl`. Provide {@link AlertsHttp}. For receivers and routes, use the
 * `AlertConfig` resource or the `*AlertConfigReceiver` and `*AlertConfigRoute` bindings: this
 * API can only read them.
 *
 * Calls authenticate with the credential's HTTP Basic, so this grants no STACKIT role
 * and creates no service account: the credential's username and `Redacted` password
 * and the instance's URL travel through the host's environment. STACKIT has no
 * narrower credential, so it can do everything the API allows on the instance: the
 * limit here is the client's surface, not a permission. When the instance has an
 * `acl`, the host's egress address has to be in it.
 *
 * ### Silencing Alerts
 * **Example:** Silence an alert during a maintenance window, from a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Metrics = Stackit.Observability.Instance("Metrics", {});
 * export const Reader = Metrics.pipe(
 *   Effect.flatMap((metrics) =>
 *     Stackit.Observability.Credential("Reader", { instanceId: metrics.instanceId }),
 *   ),
 * );
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const metrics = yield* Metrics;
 *     const reader = yield* Reader;
 *     const alerts = yield* Stackit.Observability.Alerts(metrics, reader);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { silenceID } = yield* alerts.createSilence({
 *           matchers: [{ name: "alertname", value: "HighLatency", isRegex: false, isEqual: true }],
 *           startsAt: "2026-11-01T00:00:00Z",
 *           endsAt: "2026-11-01T02:00:00Z",
 *           createdBy: "maintenance",
 *           comment: "Planned maintenance",
 *         });
 *         return yield* HttpServerResponse.json({ silenceID });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Observability.AlertsHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Observability
 */
export interface Alerts extends Binding.Service<
  Alerts,
  "Stackit.Observability.Alerts",
  (instance: Instance, credential: Credential) => Effect.Effect<AlertsClient>
> {}

export const Alerts = Binding.Service<Alerts>("Stackit.Observability.Alerts");
