import * as Binding from "alchemy/Binding";
import { sanitizeKey } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import type { Instance } from "./Instance.ts";

/** One alert of a notification. */
export interface AlertNotificationAlert {
  /** `firing` or `resolved`. */
  readonly status: string;
  /** The alert's labels. */
  readonly labels: Readonly<Record<string, string>>;
  /** The alert's annotations. */
  readonly annotations: Readonly<Record<string, string>>;
  /** When the alert started firing, in RFC 3339. */
  readonly startsAt: string;
  /** When the alert resolved, in RFC 3339. Alertmanager sends a zero time while it fires. */
  readonly endsAt: string;
  /** Link to the rule that fired. */
  readonly generatorURL: string;
  /** Identifies the alert. */
  readonly fingerprint: string;
}

/**
 * A notification from an instance's Alertmanager: its standard webhook body. Batched
 * alerts arrive together, grouped by the route's `groupBy`.
 *
 * @see {@link https://prometheus.io/docs/alerting/latest/configuration/#webhook_config | Alertmanager webhook body}
 */
export interface AlertNotification {
  /** Version of the webhook body. */
  readonly version: string;
  /** `firing` if any alert of the group is firing, otherwise `resolved`. */
  readonly status: string;
  /** Name of the receiver that was notified. */
  readonly receiver: string;
  /** Identifies the group. */
  readonly groupKey: string;
  /** Labels the group was formed by. */
  readonly groupLabels: Readonly<Record<string, string>>;
  /** Labels every alert of the group has. */
  readonly commonLabels: Readonly<Record<string, string>>;
  /** Annotations every alert of the group has. */
  readonly commonAnnotations: Readonly<Record<string, string>>;
  /** Link back to the Alertmanager. */
  readonly externalURL: string;
  /** Number of alerts the body had to leave out. */
  readonly truncatedAlerts: number;
  /** The alerts. */
  readonly alerts: ReadonlyArray<AlertNotificationAlert>;
}

export interface AlertEventSourceProps {
  /**
   * Token that proves a delivery came from this instance. STACKIT's API has no way to
   * sign a request or set a header, so it travels in the URL's query string. When omitted,
   * a random one is generated at deploy and bound onto the host.
   */
  secret?: Redacted.Redacted<string>;
  /**
   * Path on the host that alerts are delivered to. Defaults to a path per instance. Set one
   * per call to consume an instance's alerts more than once on a host: each path gets its own
   * webhook, route and token.
   */
  path?: string;
  /** Matchers an alert has to fulfil, such as `severity="critical"`. At most 5. */
  matchers?: string[];
  /** Labels alerts are batched by. */
  groupBy?: string[];
  /** How long to wait before the first notification of a group. */
  groupWait?: string;
  /** How long to wait before notifying about new alerts in a group already notified. */
  groupInterval?: string;
  /** How long to wait before sending a notification again. */
  repeatInterval?: string;
  /**
   * Also notify when an alert resolves.
   *
   * @default true
   */
  sendResolved?: boolean;
}

/** Handles one notification. A failure answers 500, and Alertmanager tries again. */
export type AlertHandler<E = never, Req = never> = (
  notification: AlertNotification,
) => Effect.Effect<void, E, Req>;

export type AlertEventSourceService = <E = never, Req = never>(
  instance: Instance,
  props: AlertEventSourceProps,
  process: AlertHandler<E, Req>,
) => Effect.Effect<void, never, never>;

/**
 * Event source connecting an instance's Alertmanager to a runtime: a webhook receiver and
 * a route on the instance that deliver to the runtime's URL. It is the only thing in
 * STACKIT Observability that can invoke a runtime.
 *
 * Consume it through {@link consumeAlerts}, and provide
 * `Stackit.Observability.AlertEventSourceLive`. It works on any host providing core's
 * `WebhookHost`, which today means a Cloudflare Worker. A STACKIT Function has a public
 * URL but doesn't provide `WebhookHost` yet. The contract is a `Binding.Service`, so a
 * runtime with another way to receive HTTP can ship its own implementation layer.
 *
 * Grants nothing on the host: the deploy creates the receiver and route with the
 * deployer's credentials, and deliveries come in over HTTP.
 *
 * ### Reacting to Alerts
 * **Example:** Run an Effect for every alert a Worker receives
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Metrics = Stackit.Observability.Instance("Metrics", {});
 *
 * export default class Responder extends Cloudflare.Worker<Responder>()(
 *   "Responder",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     yield* Stackit.Observability.consumeAlerts(
 *       Metrics,
 *       { matchers: ['severity="critical"'], groupBy: ["alertname"] },
 *       (notification) => Effect.log(notification.status, notification.groupLabels),
 *     );
 *     return { fetch: HttpServerResponse.text("ok") };
 *   }).pipe(Effect.provide(Stackit.Observability.AlertEventSourceLive)),
 * ) {}
 * ```
 *
 * @binding
 * @category Observability
 */
export interface AlertEventSource extends Binding.Service<
  AlertEventSource,
  "Stackit.Observability.AlertEventSource",
  AlertEventSourceService
> {}

export const AlertEventSource = Binding.Service<AlertEventSource>(
  "Stackit.Observability.AlertEventSource",
);

/**
 * Subscribe an Effect handler to an instance's alerts, for the host's whole life.
 *
 * @param instance The instance, or the Effect that declares it.
 * @param props Which alerts, and how they are batched.
 * @param process The handler. A failure answers 500, and Alertmanager tries again.
 */
export const consumeAlerts = <E = never, Req = never, ResourceReq = never>(
  instance: Instance | Effect.Effect<Instance, never, ResourceReq>,
  props: AlertEventSourceProps,
  process: AlertHandler<E, Req>,
): Effect.Effect<void, never, AlertEventSource | ResourceReq> =>
  (Effect.isEffect(instance) ? instance : Effect.succeed(instance)).pipe(
    Effect.flatMap((value) => AlertEventSource.use((source) => source(value, props, process))),
  );

/** Default path of an instance's deliveries. */
export const alertPath = (
  instance: Pick<Instance, "LogicalId">,
  props: Pick<AlertEventSourceProps, "path">,
) => props.path ?? `/__alchemy/stackit/alerts/${sanitizeKey(instance.LogicalId).toLowerCase()}`;

/** A path as letters and digits, so that different paths stay different; empty for the default. */
const pathKey = (props: Pick<AlertEventSourceProps, "path">) =>
  (props.path ?? "").replace(/[^a-zA-Z0-9]/g, (char) => char.charCodeAt(0).toString(16));

/**
 * Logical id of the webhook behind a delivery path. A resource declared twice under one id
 * is one resource, so the path has to be part of it, or a second path would silently get
 * no webhook.
 */
export const alertWebhookId = (
  instance: Pick<Instance, "LogicalId">,
  props: Pick<AlertEventSourceProps, "path">,
) => `${instance.LogicalId}Alerts${pathKey(props)}`;

/** Name the delivery token is bound onto the host under. */
export const alertSecretEnvName = (
  instance: Pick<Instance, "LogicalId">,
  props: Pick<AlertEventSourceProps, "path">,
) => {
  const key = pathKey(props);
  return `STACKIT_ALERTS_${sanitizeKey(instance.LogicalId).toUpperCase()}${key === "" ? "" : `_${key}`}_TOKEN`;
};
