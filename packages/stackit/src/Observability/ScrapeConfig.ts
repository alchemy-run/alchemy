import * as observability from "@distilled.cloud/stackit/observability";
import { Unowned } from "alchemy/AdoptPolicy";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import { StackitEnvironment } from "../Environment.ts";
import { hasUnresolvedTrigger, rawProp, triggerProps } from "../internal/diff.ts";
import { secretsDiffer } from "../internal/equal.ts";
import { waitFor, waitUntilGone } from "../internal/wait.ts";
import type { Providers } from "../Providers.ts";
import {
  asRedacted,
  CONFIG_DELETE_TIMEOUT,
  CONFIG_TIMEOUT,
  dropsMember,
  generatedName,
  isGeneratedName,
  isInstanceGone,
  listOwnedInstances,
  matches,
  type InstanceScope,
} from "./internal.ts";

/** Targets of a scrape job. */
export interface ScrapeStaticConfig {
  /** Host and port of each target, such as `app.example.com:443`. */
  targets: string[];
  /** Labels added to every metric from these targets, at most 10. */
  labels?: Record<string, string>;
}

/** Basic auth the job sends to its targets. */
export interface ScrapeBasicAuth {
  /** Username. */
  username: string;
  /** Password. */
  password: string | Redacted.Redacted<string>;
}

/** OAuth 2.0 client credentials the job gets its token with. */
export interface ScrapeOauth2 {
  /** Client id. */
  clientId: string;
  /** Client secret. */
  clientSecret: string | Redacted.Redacted<string>;
  /** Token endpoint. */
  tokenUrl: string;
  /** Scopes to ask for. */
  scopes?: string[];
  /** TLS settings for the token endpoint. */
  tlsConfig?: ScrapeTlsConfig;
}

/** TLS settings of a scrape. */
export interface ScrapeTlsConfig {
  /** Accept any server certificate. */
  insecureSkipVerify?: boolean;
}

/** HTTP service discovery: a URL the job fetches its targets from. */
export interface ScrapeHttpSdConfig {
  /** URL the targets are fetched from. */
  url: string;
  /** How often to fetch them, such as `60s`. At least 60 seconds. */
  refreshInterval?: string;
  /** Basic auth for the URL. */
  basicAuth?: ScrapeBasicAuth;
  /** OAuth 2.0 for the URL. */
  oauth2?: ScrapeOauth2;
  /** TLS settings for the URL. */
  tlsConfig?: ScrapeTlsConfig;
}

/** A rule that rewrites or drops scraped metrics. */
export interface ScrapeMetricsRelabelConfig {
  /** What to do when `regex` matches. */
  action?: "replace" | "keep" | "drop" | "hashmod" | "labelmap" | "labeldrop" | "labelkeep";
  /** Labels whose values are joined and matched against `regex`. */
  sourceLabels?: string[];
  /** Joins the source label values. */
  separator?: string;
  /** Regular expression to match. */
  regex?: string;
  /** Modulus of the hash, for `hashmod`. */
  modulus?: number;
  /** Label that receives the result, required for `replace`. */
  targetLabel?: string;
  /** Value written on a match. */
  replacement?: string;
}

export interface ScrapeConfigProps {
  /** Id of the instance that scrapes. Changing it replaces the job. */
  instanceId: string;
  /**
   * Name of the job, 1 to 200 of `a-zA-Z0-9-`. Changing it replaces the job.
   *
   * @default a unique name generated from the stack, stage and logical ID
   */
  jobName?: string;
  /** What to scrape. */
  staticConfigs: ScrapeStaticConfig[];
  /**
   * How often to scrape, at least 60 seconds.
   *
   * @default "5m"
   */
  scrapeInterval?: string;
  /**
   * How long one scrape may take, less than `scrapeInterval`.
   *
   * @default "2m"
   */
  scrapeTimeout?: string;
  /**
   * Protocol to scrape with.
   *
   * @default "https"
   */
  scheme?: "http" | "https";
  /**
   * Path on the targets that serves metrics.
   *
   * @default "/metrics"
   */
  metricsPath?: string;
  /** Most samples one scrape may take; beyond it the scrape counts as failed. The plan caps it. */
  sampleLimit?: number;
  /** HTTP parameters sent on every scrape, at most 5. */
  params?: Record<string, string[]>;
  /** Let the target's labels win over the job's when they clash. */
  honorLabels?: boolean;
  /** Use the timestamps the target exposes. */
  honorTimeStamps?: boolean;
  /** Rules that rewrite or drop scraped metrics. */
  metricsRelabelConfigs?: ScrapeMetricsRelabelConfig[];
  /** TLS settings of the scrape. */
  tlsConfig?: ScrapeTlsConfig;
  /** Basic auth for the targets. No other authentication may be set with it. */
  basicAuth?: ScrapeBasicAuth;
  /** Bearer token for the targets. No other authentication may be set with it. */
  bearerToken?: string | Redacted.Redacted<string>;
  /**
   * OAuth 2.0 for the targets. No other authentication may be set with it. The API's
   * update can't change it, so changing it replaces the job.
   */
  oauth2?: ScrapeOauth2;
  /** Discover targets over HTTP. The API's update can't change it, so changing it replaces the job. */
  httpSdConfigs?: ScrapeHttpSdConfig[];
  /** Project that owns the instance. Changing it replaces the job. @default the profile's project */
  projectId?: string;
}

export interface ScrapeConfigAttributes {
  /** Name of the job. */
  jobName: string;
  /** Id of the instance that scrapes. */
  instanceId: string;
  /** Project that owns the instance. */
  projectId: string;
  /** What the job scrapes. */
  staticConfigs: { targets: string[]; labels: Record<string, string> }[];
  /** How often the job scrapes. */
  scrapeInterval: string;
  /** How long one scrape may take. */
  scrapeTimeout: string;
  /** Protocol the job scrapes with. */
  scheme: string | undefined;
  /** Path on the targets that serves metrics. */
  metricsPath: string | undefined;
  /** Most samples one scrape may take. */
  sampleLimit: number | undefined;
}

export type ScrapeConfig = Resource<
  "Stackit.Observability.ScrapeConfig",
  ScrapeConfigProps,
  ScrapeConfigAttributes,
  never,
  Providers
>;

/**
 * A Prometheus scrape job on a `Stackit.Observability.Instance`.
 *
 * The job name is its identity: changing it, the instance, `oauth2` or
 * `httpSdConfigs` replaces the job. Everything else updates in place. Jobs have no
 * labels: a job found by a name you chose, without state, is reported as unowned and
 * only taken over with `--adopt`.
 *
 * Secrets (`basicAuth`, `bearerToken`, `oauth2`) stay out of the attributes.
 *
 * ### Scraping Targets
 * **Example:** Scrape a service every five minutes
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const instance = yield* Stackit.Observability.Instance("Metrics", {});
 * const job = yield* Stackit.Observability.ScrapeConfig("Api", {
 *   instanceId: instance.instanceId,
 *   staticConfigs: [
 *     { targets: ["api.example.com:443"], labels: { env: "prod" } },
 *   ],
 * });
 * ```
 *
 * **Example:** Every minute, over plain HTTP, on another path
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const instance = yield* Stackit.Observability.Instance("Metrics", {});
 * const job = yield* Stackit.Observability.ScrapeConfig("Node", {
 *   instanceId: instance.instanceId,
 *   jobName: "node",
 *   scheme: "http",
 *   metricsPath: "/internal/metrics",
 *   scrapeInterval: "1m",
 *   scrapeTimeout: "30s",
 *   staticConfigs: [{ targets: ["203.0.113.10:9100"] }],
 * });
 * ```
 *
 * ### Authenticating to Targets
 * **Example:** A bearer token from a redacted config value
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Config from "effect/Config";
 *
 * const instance = yield* Stackit.Observability.Instance("Metrics", {});
 * const bearerToken = yield* Config.redacted("SCRAPE_TOKEN");
 * const job = yield* Stackit.Observability.ScrapeConfig("Api", {
 *   instanceId: instance.instanceId,
 *   bearerToken,
 *   staticConfigs: [{ targets: ["api.example.com:443"] }],
 * });
 * ```
 *
 * ### Dropping Metrics
 * **Example:** Drop what you don't need before it counts against the plan
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const instance = yield* Stackit.Observability.Instance("Metrics", {});
 * const job = yield* Stackit.Observability.ScrapeConfig("Api", {
 *   instanceId: instance.instanceId,
 *   sampleLimit: 5000,
 *   metricsRelabelConfigs: [
 *     { action: "drop", sourceLabels: ["__name__"], regex: "go_.*" },
 *   ],
 *   staticConfigs: [{ targets: ["api.example.com:443"] }],
 * });
 * ```
 *
 * ### Replacement Cautions
 * **Example:** Renaming a job starts a new series
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * // The job name is the `job` label on every metric, so dashboards and alerts on
 * // the old name stop matching. The old job is deleted.
 * const instance = yield* Stackit.Observability.Instance("Metrics", {});
 * const job = yield* Stackit.Observability.ScrapeConfig("Api", {
 *   instanceId: instance.instanceId,
 *   jobName: "api-v2",
 *   staticConfigs: [{ targets: ["api.example.com:443"] }],
 * });
 * ```
 *
 * @resource
 * @product STACKIT Observability
 * @category Observability
 */
export const ScrapeConfig = Resource<ScrapeConfig>("Stackit.Observability.ScrapeConfig");

/** Terraform's defaults. The API requires all of these. Terraform's scheme is `http`; ours is safer. */
const DEFAULT_SCHEME = "https";
const DEFAULT_METRICS_PATH = "/metrics";
const DEFAULT_SCRAPE_INTERVAL = "5m";
const DEFAULT_SCRAPE_TIMEOUT = "2m";

const getJobOrUndefined = (scope: InstanceScope, jobName: string) =>
  observability.getScrapeConfig({ ...scope, jobName }).pipe(
    Effect.map(({ data }) => data),
    Effect.catchTag("NotFound", () => Effect.undefined),
  );

const toAttrs = (scope: InstanceScope, job: observability.Job): ScrapeConfigAttributes => ({
  jobName: job.jobName,
  instanceId: scope.instanceId,
  projectId: scope.projectId,
  staticConfigs: job.staticConfigs.map((config) => ({
    targets: [...config.targets],
    labels: Object.fromEntries(
      Object.entries(config.labels ?? {}).flatMap(([key, value]) =>
        value === undefined ? [] : [[key, value] as const],
      ),
    ),
  })),
  scrapeInterval: job.scrapeInterval,
  scrapeTimeout: job.scrapeTimeout,
  scheme: job.scheme,
  metricsPath: job.metricsPath,
  sampleLimit: job.sampleLimit,
});

/** A basic auth block with its password as `Redacted`. */
const redactedBasicAuth = (basicAuth: ScrapeBasicAuth | undefined) =>
  basicAuth === undefined
    ? undefined
    : { username: basicAuth.username, password: asRedacted(basicAuth.password) };

/** What the job should be, in the shape of the live `Job`. */
const desiredJob = (news: ScrapeConfigProps) => ({
  scheme: news.scheme ?? DEFAULT_SCHEME,
  metricsPath: news.metricsPath ?? DEFAULT_METRICS_PATH,
  scrapeInterval: news.scrapeInterval ?? DEFAULT_SCRAPE_INTERVAL,
  scrapeTimeout: news.scrapeTimeout ?? DEFAULT_SCRAPE_TIMEOUT,
  staticConfigs: news.staticConfigs.map((config) => ({
    targets: config.targets,
    labels: config.labels ?? {},
  })),
  params: news.params ?? {},
  metricsRelabelConfigs: news.metricsRelabelConfigs ?? [],
  sampleLimit: news.sampleLimit,
  honorLabels: news.honorLabels,
  honorTimeStamps: news.honorTimeStamps,
  tlsConfig: news.tlsConfig,
  basicAuth: redactedBasicAuth(news.basicAuth) ?? {},
  bearerToken: asRedacted(news.bearerToken) ?? "",
});

/**
 * The members `desiredJob` leaves unset when they aren't declared, which `matches` then
 * doesn't compare, so removing one has to force the update. The update is a whole-job PUT,
 * and the read-back skips the member.
 */
const optionalMembersOf = (props: ScrapeConfigProps) => ({
  sampleLimit: props.sampleLimit,
  honorLabels: props.honorLabels,
  honorTimeStamps: props.honorTimeStamps,
  tlsConfig: props.tlsConfig,
});

/** The body both the create and the update take. */
const jobBody = (news: ScrapeConfigProps) => ({
  scheme: news.scheme ?? DEFAULT_SCHEME,
  metricsPath: news.metricsPath ?? DEFAULT_METRICS_PATH,
  scrapeInterval: news.scrapeInterval ?? DEFAULT_SCRAPE_INTERVAL,
  scrapeTimeout: news.scrapeTimeout ?? DEFAULT_SCRAPE_TIMEOUT,
  staticConfigs: news.staticConfigs.map((config) => ({
    targets: [...config.targets],
    ...(config.labels !== undefined ? { labels: config.labels } : {}),
  })),
  ...(news.params !== undefined ? { params: news.params } : {}),
  ...(news.metricsRelabelConfigs !== undefined
    ? {
        metricsRelabelConfigs: news.metricsRelabelConfigs.map((config) => ({
          ...config,
          ...(config.sourceLabels !== undefined ? { sourceLabels: [...config.sourceLabels] } : {}),
        })),
      }
    : {}),
  ...(news.sampleLimit !== undefined ? { sampleLimit: news.sampleLimit } : {}),
  ...(news.honorLabels !== undefined ? { honorLabels: news.honorLabels } : {}),
  ...(news.honorTimeStamps !== undefined ? { honorTimeStamps: news.honorTimeStamps } : {}),
  ...(news.tlsConfig !== undefined ? { tlsConfig: news.tlsConfig } : {}),
  ...(news.basicAuth !== undefined ? { basicAuth: news.basicAuth } : {}),
  ...(news.bearerToken !== undefined ? { bearerToken: news.bearerToken } : {}),
});

/** Delete a job and wait until it is gone. Idempotent. */
const deleteJobAndWait = (scope: InstanceScope, jobName: string) =>
  Effect.gen(function* () {
    yield* observability
      .deleteScrapeConfig({ ...scope, jobName })
      .pipe(Effect.catchTag("NotFound", () => Effect.void));
    yield* waitUntilGone({
      resource: `STACKIT Observability scrape job ${jobName}`,
      read: getJobOrUndefined(scope, jobName),
      timeout: CONFIG_DELETE_TIMEOUT,
    });
  });

export const ScrapeConfigProvider = () =>
  Provider.succeed(ScrapeConfig, {
    stables: ["jobName", "instanceId", "projectId"],
    nuke: { dependsOn: ["Stackit.Observability.Instance"] },

    list: Effect.fn(function* () {
      const env = yield* StackitEnvironment.current;
      const projectId = env.projectId;
      const instances = yield* listOwnedInstances(projectId);
      const attrs: ScrapeConfigAttributes[] = [];
      for (const instance of instances) {
        const scope = { projectId, instanceId: instance.id };
        if (yield* isInstanceGone(scope)) continue;
        const { data } = yield* observability.listScrapeConfigs(scope);
        for (const job of data) {
          if (isGeneratedName(job.jobName)) attrs.push(toAttrs(scope, job));
        }
      }
      return attrs;
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (output === undefined) return undefined;
      // An unresolved value can resolve to the one the job already has, and an explicit
      // name can't exist twice on an instance. A generated name holds the generation.
      if (
        hasUnresolvedTrigger<ScrapeConfigProps>(news, [
          "instanceId",
          "projectId",
          "jobName",
          "oauth2",
          "httpSdConfigs",
        ])
      ) {
        return {
          action: "replace",
          deleteFirst: rawProp<ScrapeConfigProps>(news, "jobName") !== undefined,
        } as const;
      }
      const env = yield* StackitEnvironment.current;
      const resolved = triggerProps<ScrapeConfigProps>(news);
      if (
        resolved.instanceId !== output.instanceId ||
        (resolved.projectId ?? env.projectId) !== output.projectId ||
        (resolved.jobName !== undefined && resolved.jobName !== output.jobName)
      ) {
        return { action: "replace", deleteFirst: false } as const;
      }
      // The API's update takes neither. The same name stays on the same instance, so an
      // explicit one has to go first.
      if (
        olds !== undefined &&
        (secretsDiffer(olds.oauth2, resolved.oauth2) ||
          secretsDiffer(olds.httpSdConfigs, resolved.httpSdConfigs))
      ) {
        return { action: "replace", deleteFirst: resolved.jobName !== undefined } as const;
      }
      // Everything else updates in place (engine default: props changed).
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output, previous }) {
      const env = yield* StackitEnvironment.current;
      const projectId = output?.projectId ?? olds?.projectId ?? env.projectId;
      const instanceId = output?.instanceId ?? olds?.instanceId;
      if (instanceId === undefined) return undefined;
      const scope = { projectId, instanceId };
      if (yield* isInstanceGone(scope)) return undefined;
      const generated = yield* generatedName(id);
      const jobName = output?.jobName ?? olds?.jobName ?? generated;
      const job = yield* getJobOrUndefined(scope, jobName);
      if (job === undefined) return undefined;
      const attrs = toAttrs(scope, job);
      // A generated name holds this generation. An explicit one proves nothing without
      // state, unless it is the generation being replaced, at the same scope: the same
      // name on another instance is someone else's job.
      const isPrevious =
        previous?.jobName === jobName &&
        previous.instanceId === instanceId &&
        previous.projectId === projectId;
      return output !== undefined || jobName === generated || isPrevious ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, olds, output }) {
      const env = yield* StackitEnvironment.current;
      const projectId = news.projectId ?? output?.projectId ?? env.projectId;
      const scope = { projectId, instanceId: news.instanceId };
      const generated = yield* generatedName(id);
      const jobName = news.jobName ?? output?.jobName ?? generated;
      const resource = `STACKIT Observability scrape job ${jobName}`;
      const desired = desiredJob(news);
      const dropped =
        olds !== undefined && dropsMember(optionalMembersOf(olds), optionalMembersOf(news));

      // 1. Observe
      const observed = yield* getJobOrUndefined(scope, jobName);

      // 2. Ensure — asynchronous: wait until the job reads back.
      const created = observed === undefined;
      if (created) {
        yield* observability.createScrapeConfig({
          ...scope,
          jobName,
          ...jobBody(news),
          ...(news.oauth2 !== undefined ? { oauth2: news.oauth2 } : {}),
          ...(news.httpSdConfigs !== undefined ? { httpSdConfigs: news.httpSdConfigs } : {}),
        });
      }

      const converge = Effect.gen(function* () {
        const current = yield* waitFor({
          resource,
          read: getJobOrUndefined(scope, jobName),
          ready: (job) => job !== undefined,
          state: (job) => (job === undefined ? "not visible yet" : "ready"),
          timeout: CONFIG_TIMEOUT,
        });

        // 3. Sync — the whole job, only when it differs from what is live.
        if (!matches(desired, current) || dropped) {
          yield* observability.updateScrapeConfig({ ...scope, jobName, ...jobBody(news) });
        }

        // 4. Return — the API reports no status for an update (the Terraform provider
        // sleeps 15 seconds instead), so only the desired values finish the wait.
        const final = yield* waitFor({
          resource,
          read: getJobOrUndefined(scope, jobName),
          ready: (job) => job !== undefined && matches(desired, job, { ignoreSecrets: true }),
          state: (job) => (job === undefined ? "not visible yet" : "applying"),
          timeout: CONFIG_TIMEOUT,
        });
        // `ready` only passes a job.
        return toAttrs(scope, final as observability.Job);
      });

      // A job state never hears of would read as unowned on the next deploy if it has
      // an explicit name.
      return yield* created
        ? converge.pipe(Effect.onError(() => deleteJobAndWait(scope, jobName).pipe(Effect.ignore)))
        : converge;
    }),

    delete: Effect.fn(function* ({ output }) {
      const scope = { projectId: output.projectId, instanceId: output.instanceId };
      if (yield* isInstanceGone(scope)) return;
      yield* deleteJobAndWait(scope, output.jobName);
    }),
  });
