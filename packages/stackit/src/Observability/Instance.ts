import * as observability from "@distilled.cloud/stackit/observability";
import { Unowned } from "alchemy/AdoptPolicy";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import { StackitEnvironment } from "../Environment.ts";
import { hasUnresolvedTrigger, rawProp, triggerProps } from "../internal/diff.ts";
import { sameMembers } from "../internal/equal.ts";
import { waitFor, waitUntilGone } from "../internal/wait.ts";
import type { Providers } from "../Providers.ts";
import {
  asRedacted,
  assertNoMaskedSecrets,
  CONFIG_TIMEOUT,
  generatedName,
  getInstanceOrUndefined,
  INSTANCE_CREATE_TIMEOUT,
  INSTANCE_DELETE_TIMEOUT,
  INSTANCE_POLL,
  INSTANCE_UPDATE_TIMEOUT,
  isGeneratedName,
  matches,
  ObservabilityConfigError,
  retentionDays,
  type InstanceScope,
} from "./internal.ts";

/** The cheapest plan that holds metrics. It has no logs and no traces. */
const DEFAULT_PLAN = "Observability-Monitoring-Starter-EU01";

/** Generic OAuth login for an instance's Grafana. */
export interface InstanceGrafanaOauth {
  /** Whether the OAuth login is on. */
  enabled: boolean;
  /** Authentication endpoint of the identity provider. */
  authUrl: string;
  /** Token endpoint of the identity provider. */
  tokenUrl: string;
  /** Endpoint that returns OpenID UserInfo information. */
  apiUrl: string;
  /** OAuth client id. */
  oauthClientId: string;
  /** OAuth client secret. */
  oauthClientSecret: string | Redacted.Redacted<string>;
  /** JMESPath that turns a token into a Grafana role (`Viewer`, `Editor`, `Admin`). */
  roleAttributePath: string;
  /** Deny access when `roleAttributePath` yields no valid role, instead of assigning `Viewer`. */
  roleAttributeStrict?: boolean;
  /** Let `roleAttributePath` return `GrafanaAdmin` to make a user a server administrator. */
  allowAssignGrafanaAdmin?: boolean;
  /** Display name of the login. */
  name?: string;
  /** Space-separated token scopes. */
  scopes?: string;
  /** Use Proof Key for Code Exchange. */
  usePkce?: boolean;
}

/** Settings of an instance's Grafana. Anything omitted stays as it is live. */
export interface InstanceGrafana {
  /** Let anyone read dashboards without logging in. */
  publicReadAccess?: boolean;
  /** Log in with STACKIT SSO. Turning it on overwrites `genericOauth`. */
  useStackitSso?: boolean;
  /** Log in through your own identity provider. */
  genericOauth?: InstanceGrafanaOauth;
}

export interface InstanceProps {
  /**
   * Display name of the instance, 1 to 200 characters. Updates in place.
   *
   * @default a unique name generated from the stack, stage and logical ID
   */
  name?: string;
  /**
   * Plan name, such as `Observability-Starter-EU01`. Updates in place, which can
   * change what the instance can do: only an `Observability-*` plan has logs and
   * traces, and `Observability-Monitoring-*` has neither.
   *
   * @default "Observability-Monitoring-Starter-EU01", and the current plan once deployed
   */
  plan?: string;
  /** Additional parameters of the plan. Updates in place; omit to leave them as they are. */
  parameters?: Record<string, string>;
  /**
   * Whether Grafana keeps a built-in server admin. STACKIT recommends `false` and
   * logging in with STACKIT SSO. Going from `false` to `true` is not possible: the
   * deploy fails, because the API can't bring the admin back.
   *
   * @default false on create; once deployed, omit to leave it as it is
   */
  grafanaAdminEnabled?: boolean;
  /**
   * CIDR ranges allowed to reach the instance. Updates in place; omit to leave it
   * as it is, and pass `[]` to clear it.
   */
  acl?: string[];
  /**
   * Days to keep raw metrics, 2 to 780. Updates in place; omit to leave it as it is.
   * The API moves a value outside the range to its nearest end.
   *
   * @default 90 on a new instance
   */
  metricsRetentionDays?: number;
  /**
   * Days to keep 5-minute downsampled metrics, 10 to 780. Updates in place; omit to
   * leave it as it is.
   *
   * @default 90 on a new instance
   */
  metricsRetentionDays5m?: number;
  /**
   * Days to keep 1-hour downsampled metrics, 10 to 780. Updates in place; omit to
   * leave it as it is.
   *
   * @default 90 on a new instance
   */
  metricsRetentionDays1h?: number;
  /**
   * Days to keep logs, at most 30. Needs a plan with logs. Updates in place; omit to
   * leave it as it is.
   *
   * @default 7 on a new instance
   */
  logsRetentionDays?: number;
  /**
   * Days to keep traces, at most 30. Needs a plan with traces. Updates in place; omit
   * to leave it as it is.
   *
   * @default 7 on a new instance
   */
  tracesRetentionDays?: number;
  /** Grafana settings. Needs a plan with Grafana. Updates in place. */
  grafana?: InstanceGrafana;
  /** Project that owns the instance. Changing it replaces the instance. @default the profile's project */
  projectId?: string;
}

export interface InstanceAttributes {
  /** STACKIT instance id (UUID). Stable across updates. */
  instanceId: string;
  /** Project that owns the instance. */
  projectId: string;
  /** Display name of the instance. */
  name: string;
  /** UUID of the plan. */
  planId: string;
  /** Name of the plan. */
  planName: string;
  /** Instance status; `CREATE_SUCCEEDED` or `UPDATE_SUCCEEDED` after a deploy. */
  status: string;
  /** What went wrong, when the API reports an error. */
  error: string | undefined;
  /** Whether the instance can be updated right now. */
  isUpdatable: boolean;
  /** Parameters of the plan. */
  parameters: Record<string, string>;
  /** CIDR ranges allowed to reach the instance. */
  acl: string[];
  /** Whether Grafana has a built-in server admin. */
  grafanaAdminEnabled: boolean;
  /** Whether anyone can read Grafana dashboards without logging in. */
  grafanaPublicReadAccess: boolean;
  /** Whether Grafana logs in with STACKIT SSO. */
  grafanaUseStackitSso: boolean;
  /** Days raw metrics are kept. `undefined` on a plan without metrics. */
  metricsRetentionDays: number | undefined;
  /** Days 5-minute downsampled metrics are kept. `undefined` on a plan without metrics. */
  metricsRetentionDays5m: number | undefined;
  /** Days 1-hour downsampled metrics are kept. `undefined` on a plan without metrics. */
  metricsRetentionDays1h: number | undefined;
  /** Days logs are kept. `undefined` on a plan without logs. */
  logsRetentionDays: number | undefined;
  /** Days traces are kept. `undefined` on a plan without traces. */
  tracesRetentionDays: number | undefined;
  /** STACKIT portal page of the instance. */
  dashboardUrl: string;
  /** Grafana. */
  grafanaUrl: string;
  /** Prometheus HTTP API, to query metrics. */
  metricsUrl: string;
  /** Prometheus-compatible endpoint to scrape the instance's metrics from. */
  metricsEndpointUrl: string;
  /** Prometheus remote write, to push metrics. */
  pushMetricsUrl: string;
  /** Prometheus targets page. */
  targetsUrl: string;
  /** Alertmanager. */
  alertingUrl: string;
  /** Loki, to query logs. */
  logsUrl: string;
  /** Loki push, to send logs. */
  logsPushUrl: string;
  /** OTLP over HTTP, to send logs. */
  otlpHttpLogsUrl: string;
  /** OTLP over gRPC, to send traces. */
  otlpGrpcTracesUrl: string;
  /** OTLP over HTTP, to send traces. */
  otlpHttpTracesUrl: string;
  /** OTLP traces endpoint. */
  otlpTracesUrl: string;
  /** Jaeger HTTP API. */
  jaegerHttpUrl: string;
  /** Jaeger UI. */
  jaegerUiUrl: string;
  /** Jaeger traces endpoint. */
  jaegerTracesUrl: string;
  /** Zipkin spans endpoint, to send traces. */
  zipkinSpansUrl: string;
}

export type Instance = Resource<
  "Stackit.Observability.Instance",
  InstanceProps,
  InstanceAttributes,
  never,
  Providers
>;

/**
 * A STACKIT Observability instance: managed Prometheus and Thanos, Grafana, Loki and
 * Tempo behind one plan. Scrape jobs, alert groups, credentials and checks are
 * separate resources that take its `instanceId`.
 *
 * The API still calls the product Argus. It has no labels, so a generated name is
 * what shows an instance is ours: an instance found by a name you chose, without
 * state, is reported as unowned and only taken over with `--adopt`, and
 * `alchemy unsafe nuke` only clears instances with the shape of a generated name.
 *
 * Instances take minutes to create and are billed per started hour by plan, about
 * EUR 0.04 an hour on the default plan. Everything but `projectId` updates in place.
 *
 * Use `acl` to limit who can reach Grafana and the metrics, logs and traces endpoints. A
 * replacement starts empty.
 *
 * See [STACKIT's Observability docs](https://docs.stackit.cloud/products/logging-and-monitoring/observability/).
 *
 * :::caution[Changing `projectId` replaces the Instance]
 * A replacement starts empty: metrics, logs, traces and dashboards stay with the old
 * instance and are deleted with it. Scrape jobs, alert groups, credentials and checks
 * that take its `instanceId` are replaced too.
 * :::
 *
 * ### Creating an Instance
 * **Example:** The default plan, with metrics and Grafana
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const instance = yield* Stackit.Observability.Instance("Metrics", {});
 * // instance.grafanaUrl, instance.metricsUrl, instance.pushMetricsUrl
 * ```
 *
 * **Example:** A plan with logs and traces
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const instance = yield* Stackit.Observability.Instance("Telemetry", {
 *   name: "telemetry",
 *   plan: "Observability-Starter-EU01",
 *   logsRetentionDays: 14,
 *   tracesRetentionDays: 14,
 * });
 * ```
 *
 * ### Restricting Access
 * **Example:** Only your office and your cluster can reach it
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const instance = yield* Stackit.Observability.Instance("Metrics", {
 *   acl: ["203.0.113.0/24", "198.51.100.7/32"],
 * });
 * ```
 *
 * ### Keeping Metrics Longer
 * **Example:** A year of hourly data, a month of raw data
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const instance = yield* Stackit.Observability.Instance("Metrics", {
 *   metricsRetentionDays: 30,
 *   metricsRetentionDays5m: 90,
 *   metricsRetentionDays1h: 365,
 * });
 * ```
 *
 * ### Configuring Grafana
 * **Example:** STACKIT SSO, and no built-in admin
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const instance = yield* Stackit.Observability.Instance("Metrics", {
 *   grafanaAdminEnabled: false,
 *   grafana: { useStackitSso: true, publicReadAccess: false },
 * });
 * ```
 *
 * ### Replacement Cautions
 * **Example:** Moving to another project
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * // A new, empty instance is created in the other project and the old one is
 * // deleted, with its metrics, logs, traces and dashboards.
 * const instance = yield* Stackit.Observability.Instance("Metrics", {
 *   projectId: "22222222-2222-4222-8222-222222222222",
 * });
 * ```
 *
 * ### Scrape Jobs and Credentials
 * **Example:** Scrape a service, and a credential to push and query with
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const instance = yield* Stackit.Observability.Instance("Metrics", {});
 * const job = yield* Stackit.Observability.ScrapeConfig("Api", {
 *   instanceId: instance.instanceId,
 *   staticConfigs: [{ targets: ["api.example.com:443"], labels: { env: "prod" } }],
 * });
 * const writer = yield* Stackit.Observability.Credential("Writer", {
 *   instanceId: instance.instanceId,
 * });
 * ```
 *
 * ### Binding to a Runtime
 * `QueryMetrics` and `PushLogs` authenticate with a credential's HTTP Basic, so they grant
 * no STACKIT role. STACKIT has no narrower credential, so it can do everything the API
 * allows on the instance. When the instance has an `acl`, the host's egress address has to
 * be in it.
 *
 * **Example:** Run an instant query from a Function
 * ```typescript
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
 * export default class Api extends Stackit.Functions.Function<Api>()(
 *   "Api",
 *   {
 *     main: import.meta.url,
 *     registry: { repository: "ghcr.io/my-org/api" },
 *   },
 *   Effect.gen(function* () {
 *     const metrics = yield* Metrics;
 *     const reader = yield* Reader;
 *     const queryMetrics = yield* Stackit.Observability.QueryMetrics(metrics, reader);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { data } = yield* queryMetrics.query({ query: "up" });
 *         return yield* HttpServerResponse.json({ series: data.result.length });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Observability.QueryMetricsHttp)),
 * ) {}
 * ```
 *
 * ### Event Sources
 * `consumeAlerts` adds a webhook receiver and a route to the instance's Alertmanager,
 * delivering to the host's URL. It works on any host providing core's `WebhookHost`, which
 * today means a Cloudflare Worker.
 *
 * **Example:** Handle critical alerts in a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Metrics = Stackit.Observability.Instance("Metrics", {});
 *
 * export default class Alerts extends Cloudflare.Worker<Alerts>()(
 *   "Alerts",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
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
 * @resource
 * @product STACKIT Observability
 * @category Observability
 */
export const Instance = Resource<Instance>("Stackit.Observability.Instance");

/** The aspects of an instance that live behind their own endpoints. */
interface ObservedAspects {
  acl: string[];
  metricsRetentionDays: number | undefined;
  metricsRetentionDays5m: number | undefined;
  metricsRetentionDays1h: number | undefined;
  logsRetentionDays: number | undefined;
  tracesRetentionDays: number | undefined;
}

const liveParameters = (instance: observability.GetInstanceResponse): Record<string, string> =>
  Object.fromEntries(
    Object.entries(instance.parameters ?? {}).flatMap(([key, value]) =>
      value === undefined || value === null ? [] : [[key, value] as const],
    ),
  );

const toAttrs = (
  projectId: string,
  instance: observability.GetInstanceResponse,
  aspects: ObservedAspects,
): InstanceAttributes => ({
  instanceId: instance.id,
  projectId,
  name: instance.name ?? instance.instance.name ?? "",
  planId: instance.planId,
  planName: instance.planName,
  status: instance.status,
  error: instance.error ?? undefined,
  isUpdatable: instance.isUpdatable ?? true,
  parameters: liveParameters(instance),
  ...aspects,
  grafanaAdminEnabled: instance.instance.grafanaAdminEnabled,
  grafanaPublicReadAccess: instance.instance.grafanaPublicReadAccess,
  grafanaUseStackitSso: instance.instance.grafanaUseStackitSso,
  dashboardUrl: instance.dashboardUrl,
  grafanaUrl: instance.instance.grafanaUrl,
  metricsUrl: instance.instance.metricsUrl,
  metricsEndpointUrl: instance.instance.metricsEndpointUrl,
  pushMetricsUrl: instance.instance.pushMetricsUrl,
  targetsUrl: instance.instance.targetsUrl,
  alertingUrl: instance.instance.alertingUrl,
  logsUrl: instance.instance.logsUrl,
  logsPushUrl: instance.instance.logsPushUrl,
  otlpHttpLogsUrl: instance.instance.otlpHttpLogsUrl,
  otlpGrpcTracesUrl: instance.instance.otlpGrpcTracesUrl,
  otlpHttpTracesUrl: instance.instance.otlpHttpTracesUrl,
  otlpTracesUrl: instance.instance.otlpTracesUrl,
  jaegerHttpUrl: instance.instance.jaegerHttpUrl,
  jaegerUiUrl: instance.instance.jaegerUiUrl,
  jaegerTracesUrl: instance.instance.jaegerTracesUrl,
  zipkinSpansUrl: instance.instance.zipkinSpansUrl,
});

const hasMetrics = (instance: observability.GetInstanceResponse) =>
  instance.instance.plan.totalMetricSamples !== 0;
const hasLogs = (instance: observability.GetInstanceResponse) =>
  instance.instance.plan.logsStorage !== 0;
const hasTraces = (instance: observability.GetInstanceResponse) =>
  instance.instance.plan.tracesStorage !== 0;
const hasGrafana = (instance: observability.GetInstanceResponse) =>
  instance.instance.plan.grafanaGlobalDashboards !== 0;

const isInFlight = (instance: observability.GetInstanceResponse) =>
  instance.status === "CREATING" ||
  instance.status === "UPDATING" ||
  instance.status === "DELETING";

/**
 * The aspects as they are live. Plans without a feature don't offer its endpoint
 * (the Terraform provider skips them the same way), and nothing can be read from
 * an instance that is still being worked on.
 */
const observeAspects = (
  scope: InstanceScope,
  instance: observability.GetInstanceResponse,
  cached: Partial<ObservedAspects> = {},
) =>
  Effect.gen(function* () {
    if (isInFlight(instance)) {
      return {
        acl: cached.acl ?? [],
        metricsRetentionDays: cached.metricsRetentionDays,
        metricsRetentionDays5m: cached.metricsRetentionDays5m,
        metricsRetentionDays1h: cached.metricsRetentionDays1h,
        logsRetentionDays: cached.logsRetentionDays,
        tracesRetentionDays: cached.tracesRetentionDays,
      } satisfies ObservedAspects;
    }
    const { acl } = yield* observability.listACL(scope);
    const metrics = hasMetrics(instance)
      ? yield* observability.getMetricsStorageRetention(scope)
      : undefined;
    const logs = hasLogs(instance) ? yield* observability.getLogsConfigs(scope) : undefined;
    const traces = hasTraces(instance) ? yield* observability.getTracesConfigs(scope) : undefined;
    return {
      acl: [...acl],
      metricsRetentionDays:
        metrics === undefined ? undefined : retentionDays(metrics.metricsRetentionTimeRaw),
      metricsRetentionDays5m:
        metrics === undefined ? undefined : retentionDays(metrics.metricsRetentionTime5m),
      metricsRetentionDays1h:
        metrics === undefined ? undefined : retentionDays(metrics.metricsRetentionTime1h),
      logsRetentionDays: logs === undefined ? undefined : retentionDays(logs.config.retention),
      tracesRetentionDays:
        traces === undefined ? undefined : retentionDays(traces.config.retention),
    } satisfies ObservedAspects;
  });

const findInstanceByName = (projectId: string, name: string) =>
  Effect.gen(function* () {
    const { instances } = yield* observability.listInstances({ projectId });
    const found = instances.find(
      (instance) => instance.name === name && instance.status !== "DELETE_SUCCEEDED",
    );
    return found === undefined
      ? undefined
      : yield* getInstanceOrUndefined({ projectId, instanceId: found.id });
  });

/** The plan of this name. Plan names aren't case-sensitive to the Terraform provider either. */
const findPlan = (projectId: string, planName: string) =>
  Effect.gen(function* () {
    const { plans } = yield* observability.listPlans({ projectId });
    const plan = plans.find(
      (candidate) => candidate.name?.toLowerCase() === planName.toLowerCase(),
    );
    if (plan === undefined) {
      return yield* new ObservabilityConfigError({
        instanceId: undefined,
        message: `No STACKIT Observability plan named "${planName}". Available: ${plans
          .flatMap((candidate) => (candidate.name === undefined ? [] : [candidate.name]))
          .join(", ")}`,
      });
    }
    return plan;
  });

/** Wait until the instance isn't being worked on. Failures are the caller's to judge. */
const waitForSettled = (scope: InstanceScope, timeout: Duration.Input) =>
  waitFor({
    resource: `STACKIT Observability instance ${scope.instanceId}`,
    read: observability.getInstance(scope),
    ready: (instance) => !isInFlight(instance) && instance.isUpdatable !== false,
    failed: (instance) =>
      instance.status === "CREATE_FAILED" || instance.status === "DELETE_FAILED"
        ? (instance.error ?? instance.status)
        : undefined,
    state: (instance) => instance.status,
    timeout,
    ...INSTANCE_POLL,
  });

const waitForGone = (scope: InstanceScope, staleFailure: boolean) =>
  waitUntilGone({
    resource: `STACKIT Observability instance ${scope.instanceId}`,
    read: getInstanceOrUndefined(scope),
    // A `DELETE_FAILED` read before this delete took effect says nothing about it.
    failed: (instance) =>
      instance.status === "DELETE_FAILED" && !staleFailure
        ? (instance.error ?? instance.status)
        : undefined,
    state: (instance) => instance.status,
    timeout: INSTANCE_DELETE_TIMEOUT,
    ...INSTANCE_POLL,
  });

/** Delete an instance and wait until it is gone. Idempotent. */
const deleteInstanceAndWait = (scope: InstanceScope) =>
  Effect.gen(function* () {
    const current = yield* getInstanceOrUndefined(scope);
    if (current === undefined) return;
    if (current.status === "CREATING" || current.status === "UPDATING") {
      yield* waitFor({
        resource: `STACKIT Observability instance ${scope.instanceId}`,
        read: observability.getInstance(scope),
        ready: (instance) => instance.status !== "CREATING" && instance.status !== "UPDATING",
        state: (instance) => instance.status,
        timeout: INSTANCE_CREATE_TIMEOUT,
        ...INSTANCE_POLL,
      }).pipe(Effect.catchTag("NotFound", () => Effect.void));
    }
    if (current.status !== "DELETING") {
      yield* observability
        .deleteInstance(scope)
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }
    yield* waitForGone(scope, current.status === "DELETE_FAILED");
  });

/**
 * Write one aspect only when it differs from what is live, then read it back. These
 * writes answer 202 and report no status of their own.
 */
const syncAspect = <A, E1, R1, E2, R2>(options: {
  readonly scope: InstanceScope;
  readonly label: string;
  readonly read: Effect.Effect<A, E1, R1>;
  readonly inSync: (observed: A) => boolean;
  readonly appliedBack?: (observed: A) => boolean;
  readonly write: (observed: A) => Effect.Effect<unknown, E2, R2>;
}) =>
  Effect.gen(function* () {
    const observed = yield* options.read;
    if (options.inSync(observed)) return;
    yield* options.write(observed);
    yield* waitFor({
      resource: `${options.label} of STACKIT Observability instance ${options.scope.instanceId}`,
      read: options.read,
      ready: options.appliedBack ?? options.inSync,
      timeout: CONFIG_TIMEOUT,
    });
    yield* waitForSettled(options.scope, INSTANCE_UPDATE_TIMEOUT);
  });

const unsupported = (instanceId: string, planName: string, prop: string) =>
  new ObservabilityConfigError({
    instanceId,
    message: `Plan ${planName} has no ${prop}. Remove it or use another plan.`,
  });

/**
 * The value the API ends up with: it moves a retention outside `[min, 780]` to the
 * nearest end, so comparing with what was asked for would never match.
 */
const clampRetention = (days: number, min: number) => Math.min(Math.max(days, min), 780);

const retentionMatches = (observed: string, desired: number | undefined, min: number) =>
  desired === undefined || retentionDays(observed) === clampRetention(desired, min);

const desiredGrafana = (grafana: InstanceGrafana) => ({
  publicReadAccess: grafana.publicReadAccess,
  useStackitSso: grafana.useStackitSso,
  genericOauth:
    grafana.genericOauth === undefined
      ? undefined
      : {
          ...grafana.genericOauth,
          oauthClientSecret: asRedacted(grafana.genericOauth.oauthClientSecret)!,
        },
});

export const InstanceProvider = () =>
  Provider.succeed(Instance, {
    stables: ["instanceId", "projectId"],

    list: Effect.fn(function* () {
      const env = yield* StackitEnvironment.current;
      const projectId = env.projectId;
      const { instances } = yield* observability.listInstances({ projectId });
      const attrs: InstanceAttributes[] = [];
      for (const summary of instances) {
        if (
          summary.status === "DELETE_SUCCEEDED" ||
          summary.name === undefined ||
          !isGeneratedName(summary.name)
        ) {
          continue;
        }
        const scope = { projectId, instanceId: summary.id };
        const instance = yield* getInstanceOrUndefined(scope);
        if (instance === undefined) continue;
        attrs.push(
          toAttrs(projectId, instance, {
            acl: [],
            metricsRetentionDays: undefined,
            metricsRetentionDays5m: undefined,
            metricsRetentionDays1h: undefined,
            logsRetentionDays: undefined,
            tracesRetentionDays: undefined,
          }),
        );
      }
      return attrs;
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (output === undefined) return undefined;
      // An unresolved project can resolve to the one the instance is in, where an
      // explicit name can't be used twice. A generated name holds the generation.
      if (hasUnresolvedTrigger<InstanceProps>(news, ["projectId"])) {
        return {
          action: "replace",
          deleteFirst: rawProp<InstanceProps>(news, "name") !== undefined,
        } as const;
      }
      const env = yield* StackitEnvironment.current;
      const resolved = triggerProps<InstanceProps>(news);
      if ((resolved.projectId ?? env.projectId) !== output.projectId) {
        return { action: "replace", deleteFirst: false } as const;
      }
      // Everything else updates in place (engine default: props changed).
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output, previous }) {
      const env = yield* StackitEnvironment.current;
      const projectId = output?.projectId ?? olds?.projectId ?? env.projectId;
      if (output !== undefined) {
        const scope = { projectId, instanceId: output.instanceId };
        const live = yield* getInstanceOrUndefined(scope);
        if (live !== undefined) {
          const aspects = yield* observeAspects(scope, live, output);
          return toAttrs(projectId, live, aspects);
        }
      }
      const generated = yield* generatedName(id);
      const name = output?.name ?? olds?.name ?? generated;
      const found = yield* findInstanceByName(projectId, name);
      if (found === undefined) return undefined;
      const scope = { projectId, instanceId: found.id };
      const aspects = yield* observeAspects(scope, found);
      const attrs = toAttrs(projectId, found, aspects);
      // Only this generation's generated name shows an instance is ours. A name is
      // only unique within a project, so a replaced generation has to match by both.
      const isPrevious = previous?.instanceId === found.id && previous.projectId === projectId;
      return name === generated || isPrevious ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* StackitEnvironment.current;
      const projectId = news.projectId ?? output?.projectId ?? env.projectId;
      const generated = yield* generatedName(id);
      const name = news.name ?? output?.name ?? generated;
      const planName = news.plan ?? output?.planName ?? DEFAULT_PLAN;

      // 1. Observe — by cached id in its project, then by this generation's name.
      let live =
        output?.projectId === projectId
          ? yield* getInstanceOrUndefined({ projectId, instanceId: output.instanceId })
          : undefined;
      if (live === undefined && news.name === undefined) {
        live = yield* findInstanceByName(projectId, generated);
      }

      // An instance that never finished creating can't be repaired: recreate it.
      if (live?.status === "CREATE_FAILED") {
        yield* deleteInstanceAndWait({ projectId, instanceId: live.id });
        live = undefined;
      }
      // A delete in flight (an interrupted destroy): let it finish.
      if (live?.status === "DELETING") {
        yield* waitForGone({ projectId, instanceId: live.id }, false);
        live = undefined;
      }

      // 2. Ensure
      const startingStatus = live?.status;
      const createdNow = live === undefined;
      const create = Effect.gen(function* () {
        const plan = yield* findPlan(projectId, planName);
        const created = yield* observability.createInstance({
          projectId,
          name,
          planId: plan.planId,
          // Only a plan with Grafana takes this (the Terraform provider's check).
          ...(plan.grafanaGlobalDashboards !== 0
            ? { grafanaAdminEnabled: news.grafanaAdminEnabled ?? false }
            : {}),
          ...(news.parameters !== undefined ? { parameter: news.parameters } : {}),
        });
        return created.instanceId;
      });
      const instanceId = live?.id ?? (yield* create);
      const scope = { projectId, instanceId };

      const converge = Effect.gen(function* () {
        let instance = yield* waitForSettled(
          scope,
          createdNow || startingStatus === "CREATING"
            ? INSTANCE_CREATE_TIMEOUT
            : INSTANCE_UPDATE_TIMEOUT,
        );

        // 3. Sync — name, plan, parameters and the Grafana admin share one PUT.
        const nameDrifted = (instance.name ?? "") !== name;
        const planDrifted = instance.planName.toLowerCase() !== planName.toLowerCase();
        const parametersDrifted =
          news.parameters !== undefined && !matches(news.parameters, liveParameters(instance));
        const adminWanted = news.grafanaAdminEnabled;
        if (adminWanted === true && !instance.instance.grafanaAdminEnabled) {
          return yield* unsupportedAdmin(instanceId);
        }
        const adminDrifted =
          adminWanted !== undefined && adminWanted !== instance.instance.grafanaAdminEnabled;
        // A failed update is sent again, so it recovers or the deploy fails. Otherwise
        // an unchanged instance is left alone: its status wouldn't move, and a waiter
        // would run into its budget (the Terraform provider's comment on UpdateInstance).
        const updateFailed = instance.status === "UPDATE_FAILED";
        if (nameDrifted || planDrifted || parametersDrifted || adminDrifted || updateFailed) {
          const plan = planDrifted ? yield* findPlan(projectId, planName) : undefined;
          const parameter = news.parameters ?? liveParameters(instance);
          yield* observability.updateInstance({
            ...scope,
            name,
            planId: plan?.planId ?? instance.planId,
            parameter,
            ...(hasGrafana(instance) && adminWanted !== undefined
              ? { grafanaAdminEnabled: adminWanted }
              : {}),
          });
          // The status read right after a PUT can predate it, so only the new values
          // finish the wait. The API can answer `CREATE_SUCCEEDED` after an update
          // (the Go SDK's `UpdateInstanceWaitHandler`).
          instance = yield* waitFor({
            resource: `STACKIT Observability instance ${instanceId}`,
            read: observability.getInstance(scope),
            ready: (observed) =>
              (observed.status === "UPDATE_SUCCEEDED" || observed.status === "CREATE_SUCCEEDED") &&
              observed.isUpdatable !== false &&
              observed.name === name &&
              observed.planName.toLowerCase() === planName.toLowerCase() &&
              matches(parameter, liveParameters(observed)),
            // An `UPDATE_FAILED` from before this PUT says nothing about it.
            failed: (observed) =>
              observed.status === "CREATE_FAILED" ||
              (observed.status === "UPDATE_FAILED" && !updateFailed)
                ? (observed.error ?? observed.status)
                : undefined,
            state: (observed) => observed.status,
            timeout: INSTANCE_UPDATE_TIMEOUT,
            ...INSTANCE_POLL,
          });
        }

        const { acl, grafana } = news;
        if (acl !== undefined) {
          yield* syncAspect({
            scope,
            label: "access control list",
            read: observability.listACL(scope),
            inSync: (observed) => sameMembers(observed.acl, acl),
            write: () => observability.updateACL({ ...scope, acl: [...acl] }),
          });
        }

        if (grafana !== undefined) {
          if (!hasGrafana(instance)) {
            return yield* unsupported(instanceId, instance.planName, "Grafana");
          }
          const desired = desiredGrafana(grafana);
          yield* syncAspect({
            scope,
            label: "Grafana settings",
            read: observability.getGrafanaConfigs(scope),
            inSync: (observed) => matches(desired, observed),
            appliedBack: (observed) => matches(desired, observed, { ignoreSecrets: true }),
            // A PUT sets the whole block, so what isn't declared goes back as it is live.
            write: (observed) =>
              Effect.gen(function* () {
                if (desired.useStackitSso !== true && desired.genericOauth === undefined) {
                  yield* assertNoMaskedSecrets(instanceId, {
                    genericOauth: observed.genericOauth,
                  });
                }
                return yield* observability.updateGrafanaConfigs({
                  ...scope,
                  publicReadAccess: desired.publicReadAccess ?? observed.publicReadAccess,
                  useStackitSso: desired.useStackitSso ?? observed.useStackitSso,
                  ...(desired.useStackitSso === true
                    ? {}
                    : { genericOauth: desired.genericOauth ?? observed.genericOauth }),
                });
              }),
          });
        }

        const { metricsRetentionDays, metricsRetentionDays5m, metricsRetentionDays1h } = news;
        if (
          metricsRetentionDays !== undefined ||
          metricsRetentionDays5m !== undefined ||
          metricsRetentionDays1h !== undefined
        ) {
          if (!hasMetrics(instance)) {
            return yield* unsupported(instanceId, instance.planName, "metrics retention");
          }
          yield* syncAspect({
            scope,
            label: "metrics retention",
            read: observability.getMetricsStorageRetention(scope),
            inSync: (observed) =>
              retentionMatches(observed.metricsRetentionTimeRaw, metricsRetentionDays, 2) &&
              retentionMatches(observed.metricsRetentionTime5m, metricsRetentionDays5m, 10) &&
              retentionMatches(observed.metricsRetentionTime1h, metricsRetentionDays1h, 10),
            // A PUT sets all three.
            write: (observed) =>
              observability.updateMetricsStorageRetention({
                ...scope,
                metricsRetentionTimeRaw:
                  metricsRetentionDays === undefined
                    ? observed.metricsRetentionTimeRaw
                    : `${metricsRetentionDays}d`,
                metricsRetentionTime5m:
                  metricsRetentionDays5m === undefined
                    ? observed.metricsRetentionTime5m
                    : `${metricsRetentionDays5m}d`,
                metricsRetentionTime1h:
                  metricsRetentionDays1h === undefined
                    ? observed.metricsRetentionTime1h
                    : `${metricsRetentionDays1h}d`,
              }),
          });
        }

        // Logs and traces retention are hours on the wire (the Terraform provider
        // sends `<days * 24>h` and reads hours back), unlike metrics retention.
        const { logsRetentionDays, tracesRetentionDays } = news;
        if (logsRetentionDays !== undefined) {
          if (!hasLogs(instance)) {
            return yield* unsupported(instanceId, instance.planName, "logs");
          }
          yield* syncAspect({
            scope,
            label: "logs retention",
            read: observability.getLogsConfigs(scope),
            inSync: (observed) => retentionDays(observed.config.retention) === logsRetentionDays,
            write: () =>
              observability.updateLogsConfigs({
                ...scope,
                retention: `${logsRetentionDays * 24}h`,
              }),
          });
        }
        if (tracesRetentionDays !== undefined) {
          if (!hasTraces(instance)) {
            return yield* unsupported(instanceId, instance.planName, "traces");
          }
          yield* syncAspect({
            scope,
            label: "traces retention",
            read: observability.getTracesConfigs(scope),
            inSync: (observed) => retentionDays(observed.config.retention) === tracesRetentionDays,
            write: () =>
              observability.updateTracesConfigs({
                ...scope,
                retention: `${tracesRetentionDays * 24}h`,
              }),
          });
        }

        // 4. Return
        const final = yield* observability.getInstance(scope);
        const aspects = yield* observeAspects(scope, final);
        return toAttrs(projectId, final, aspects);
      });

      // A failure after the create would leave a billed instance no state row knows.
      // A generated name is found again by the next deploy; an explicit one reads as
      // unowned, so it goes now. An instance that was already there stays.
      return yield* createdNow && news.name !== undefined
        ? converge.pipe(
            Effect.onError(() => observability.deleteInstance(scope).pipe(Effect.ignore)),
          )
        : converge;
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* deleteInstanceAndWait({
        projectId: output.projectId,
        instanceId: output.instanceId,
      });
    }),
  });

const unsupportedAdmin = (instanceId: string) =>
  new ObservabilityConfigError({
    instanceId,
    message:
      "grafanaAdminEnabled can't go back to true: the API deleted the Grafana server admin when it was set to false. Log in with STACKIT SSO, or create an admin in the Grafana UI.",
  });
