import * as cdn from "@distilled.cloud/stackit/cdn";
import { Unowned } from "alchemy/AdoptPolicy";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import { recordsEqual } from "alchemy/Util/equal";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import { StackitEnvironment } from "../Environment.ts";
import { readGeneration } from "../IaaS/internal.ts";
import { hasUnresolvedTrigger, triggerProps } from "../internal/diff.ts";
import { sameMembers, secretsDiffer } from "../internal/equal.ts";
import { waitFor, waitUntilGone } from "../internal/wait.ts";
import {
  desiredGenerationLabels,
  diffLabels,
  hasAlchemyLabels,
  hasInstanceLabel,
  isAlchemyOwned,
  stripInternalLabels,
} from "../Labels.ts";
import { covers } from "../LoadBalancer/internal.ts";
import type { Providers } from "../Providers.ts";
import {
  CDN_POLL,
  CDN_TIMEOUT,
  type CdnError,
  errorSummary,
  getDistributionOrUndefined,
  listAllDistributions,
  STALE_POLLS,
  toCdnErrors,
} from "./internal.ts";

/** An origin reached over HTTP or HTTPS, such as a Function's URL. */
export interface DistributionHttpBackend {
  /** Selects the HTTP origin. */
  type: "http";
  /**
   * URL of the origin. STACKIT ignores the path and query string and assumes
   * `https` when no protocol is given; a port is allowed.
   */
  originUrl: string;
  /**
   * Headers sent with every request to the origin. STACKIT stores them as plain
   * text, so don't put secrets here. Updated as a whole.
   */
  originRequestHeaders?: Record<string, string>;
  /**
   * Alternative origins by country: each key is an origin URL, each value the
   * ISO 3166-1 alpha-2 codes routed to it. A country can appear only once.
   */
  geofencing?: Record<string, string[]>;
}

/** Credentials the CDN uses to read a private bucket. */
export interface DistributionBucketCredentials {
  /** S3 access key id, e.g. `key.accessKeyId` of a `Stackit.ObjectStorage.AccessKey`. */
  accessKeyId: string | Redacted.Redacted<string>;
  /** S3 secret access key, e.g. `key.secretAccessKey`. */
  secretAccessKey: string | Redacted.Redacted<string>;
}

/** An origin in S3-compatible object storage. */
export interface DistributionBucketBackend {
  /** Selects the bucket origin. */
  type: "bucket";
  /**
   * Full URL of the bucket, e.g. `bucket.urlVirtualHostedStyle` of a
   * `Stackit.ObjectStorage.Bucket`.
   */
  bucketUrl: string;
  /** Region of the bucket, e.g. `eu01` for STACKIT or `us-west-1` for AWS. */
  region: string;
  /**
   * Credentials to read the bucket with. STACKIT never returns them, so a change
   * is detected against the previous props.
   */
  credentials: DistributionBucketCredentials;
}

/** Cache key options. */
export interface DistributionCacheConfig {
  /**
   * Request headers that take part in the cache key. Each one multiplies the
   * number of cached variants by the number of distinct values it has.
   */
  cacheKeyHeaders?: string[];
  /**
   * Vary the cache by query string. Without `queryStringVaryParameters`, every
   * distinct query string is its own cache entry.
   */
  queryStringVaryEnabled?: boolean;
  /** The query parameters that take part in the cache key when varying is enabled. */
  queryStringVaryParameters?: string[];
}

/** Matches a request path. */
export interface DistributionRedirectMatcher {
  /** Glob patterns, such as `/shop/*`. */
  values: string[];
  /**
   * How the patterns combine.
   * @default "ANY"
   */
  valueMatchCondition?: "ANY" | "ALL" | "NONE";
}

/** One redirect rule. */
export interface DistributionRedirectRule {
  /** Where to redirect to. */
  targetUrl: string;
  /** Status code of the redirect. */
  statusCode: 301 | 302 | 303 | 307 | 308;
  /** When the rule applies. At least one matcher is required. */
  matchers: DistributionRedirectMatcher[];
  /**
   * How the matchers combine.
   * @default "ANY"
   */
  ruleMatchCondition?: "ANY" | "ALL" | "NONE";
  /** Description of the rule. */
  description?: string;
  /** Whether the rule is active. */
  enabled?: boolean;
}

/** Redirects the CDN answers itself. */
export interface DistributionRedirects {
  /** Rules, evaluated in order. */
  rules: DistributionRedirectRule[];
}

/** Older TLS versions. Without this prop, STACKIT's default applies. */
export interface DistributionTls {
  /**
   * Accept TLS 1.0 connections.
   * @default false, when `tls` is set
   */
  enableTls10?: boolean;
  /**
   * Accept TLS 1.1 connections.
   * @default false, when `tls` is set
   */
  enableTls11?: boolean;
}

/**
 * Web application firewall settings. Rule selectors become more specific from
 * collections to groups to rules, and a more specific one wins. List the available
 * ones with {@link ListWafCollections}.
 */
export interface DistributionWaf {
  /**
   * `ENABLED` blocks, `LOG_ONLY` only logs, `DISABLED` turns the WAF off.
   */
  mode: "ENABLED" | "LOG_ONLY" | "DISABLED";
  /**
   * WAF tier. `PREMIUM` costs extra.
   * @default "FREE"
   */
  type?: "FREE" | "PREMIUM";
  /** How aggressively the WAF acts, from `L1` to `L4`. */
  paranoiaLevel?: "L1" | "L2" | "L3" | "L4";
  /** HTTP methods the distribution accepts. */
  allowedHttpMethods?: string[];
  /** HTTP versions the distribution accepts. */
  allowedHttpVersions?: string[];
  /** Request `Content-Type` values the distribution accepts. */
  allowedRequestContentTypes?: string[];
  /** Rules to enable. */
  enabledRuleIds?: string[];
  /** Rules to disable. */
  disabledRuleIds?: string[];
  /** Rules that only log. */
  logOnlyRuleIds?: string[];
  /** Rule groups to enable. */
  enabledRuleGroupIds?: string[];
  /** Rule groups to disable. */
  disabledRuleGroupIds?: string[];
  /** Rule groups that only log. */
  logOnlyRuleGroupIds?: string[];
  /** Rule collections to enable, such as `@builtin/crs/request`. */
  enabledRuleCollectionIds?: string[];
  /** Rule collections to disable. */
  disabledRuleCollectionIds?: string[];
  /** Rule collections that only log. */
  logOnlyRuleCollectionIds?: string[];
}

/** Push access logs to Grafana Loki. */
export interface DistributionLokiLogSink {
  /** Selects Loki. */
  type: "loki";
  /** Push URL, such as `https://loki.example.com/loki/api/v1/push`. */
  pushUrl: string;
  /** Basic auth credentials. */
  credentials: {
    /** User to authenticate as. */
    username: string;
    /** Password of that user. */
    password: string | Redacted.Redacted<string>;
  };
}

/** Push access logs to an OTLP endpoint. */
export interface DistributionOtlpLogSink {
  /** Selects OTLP. */
  type: "otlp";
  /** Push URL, such as `https://otlp.example.com/otlp/v1/logs`. */
  pushUrl: string;
  /** Bearer or basic auth credentials. */
  credentials:
    | {
        /** Selects a bearer token. */
        type: "bearer";
        /** The token. */
        token: string | Redacted.Redacted<string>;
      }
    | {
        /** Selects basic auth. */
        type: "basic";
        /** User to authenticate as. */
        username: string;
        /** Password of that user. */
        password: string | Redacted.Redacted<string>;
      };
}

export interface DistributionProps {
  /**
   * The one origin of the distribution. There is no path-based routing: to serve
   * `/assets/*` from a bucket and everything else from a Function on one hostname,
   * have the Function serve both. Updated in place, including a change of type.
   */
  backend: DistributionHttpBackend | DistributionBucketBackend;
  /**
   * Regions the CDN caches your content in. Updated in place.
   * @default ["EU"]
   */
  regions?: ("EU" | "US" | "AF" | "SA" | "ASIA")[];
  /**
   * How long to cache a response whose origin sends no `Cache-Control`, as an ISO
   * 8601 duration such as `P1DT2H30M`. Updated in place.
   */
  defaultCacheDuration?: string;
  /** Cache key options. Updated in place. */
  cacheConfig?: DistributionCacheConfig;
  /** ISO 3166-1 alpha-2 codes of countries to block. Updated in place. */
  blockedCountries?: string[];
  /** IPv4 addresses to block. Updated in place. */
  blockedIps?: string[];
  /** Pass the request's `Host` header through to the origin. Updated in place. */
  forwardHostHeader?: boolean;
  /** Keep the origin's cookies from reaching the end user. Updated in place. */
  stripResponseCookies?: boolean;
  /** Monthly bandwidth limit in bytes. Updated in place. */
  monthlyLimitBytes?: number;
  /** The on-the-fly image optimizer, billed while enabled. Updated in place. */
  optimizer?: {
    /** Whether the optimizer is enabled. */
    enabled: boolean;
  };
  /** Redirects the CDN answers itself. Updated in place. */
  redirects?: DistributionRedirects;
  /** Older TLS versions. Updated in place. */
  tls?: DistributionTls;
  /** Web application firewall. Updated in place. */
  waf?: DistributionWaf;
  /**
   * Where to push access logs. STACKIT never returns the credentials, so a change
   * is detected against the previous props. Updated in place.
   */
  logSink?: DistributionLokiLogSink | DistributionOtlpLogSink;
  /**
   * User labels. Alchemy's ownership labels (`alchemy.stack`, `alchemy.stage`,
   * `alchemy.id`, `alchemy.instance`) are always merged in. Updated in place.
   */
  labels?: Record<string, string>;
  /**
   * Project that owns the distribution. Defaults to the profile's project. Changing
   * it replaces the distribution.
   */
  projectId?: string;
}

/** A domain a distribution answers on. */
export interface DistributionDomain {
  /** The domain name. */
  name: string;
  /** `managed` for the domain STACKIT assigned, `custom` for one you added. */
  type: "managed" | "custom";
  /** Status of the domain. */
  status: string;
  /** Certificate type of the domain. */
  certificateType: "managed" | "custom";
}

export interface DistributionAttributes {
  /** STACKIT distribution id (UUID). Stable across updates. */
  distributionId: string;
  /** Project of the distribution. */
  projectId: string;
  /**
   * The domain STACKIT assigned to the distribution. Point the CNAME of a custom
   * domain here.
   */
  hostname: string;
  /** `https://` URL of {@link hostname}. */
  url: string;
  /** Every domain of the distribution, managed and custom. */
  domains: DistributionDomain[];
  /** Status; `ACTIVE` after a successful deploy. */
  status: string;
  /** Problems STACKIT reports on the distribution. */
  errors: CdnError[];
  /** When the distribution was created (RFC 3339). */
  createdAt: string;
  /** When its configuration last changed (RFC 3339). */
  updatedAt: string;
  /** User labels (Alchemy ownership labels stripped). */
  labels: Record<string, string>;
  /** Configuration as STACKIT reports it. It never holds credentials. */
  config: cdn.Config;
}

export type Distribution = Resource<
  "Stackit.CDN.Distribution",
  DistributionProps,
  DistributionAttributes,
  never,
  Providers
>;

/**
 * A STACKIT CDN distribution: a global content delivery endpoint in front of one
 * origin, an HTTP server or a bucket. STACKIT assigns it a managed hostname (the
 * `hostname` attribute), and {@link CustomDomain} adds your own.
 *
 * A distribution has exactly one origin. Geofencing can send countries to other
 * origins, but nothing routes by path. STACKIT bills traffic per region and has no
 * per-distribution or per-request fee; the image optimizer is billed while enabled.
 *
 * Everything updates in place except `projectId`. Deploys wait for `ACTIVE`, and
 * fail with the errors STACKIT reports when it enters `ERROR`; a later deploy
 * re-submits the configuration. Destroys wait until it is gone. Both take at most
 * 10 minutes.
 *
 * A prop you remove goes back to its default on the next update. A prop you never
 * set is left as it is live, so changes made in the portal survive. Ownership is
 * tracked with labels, and a distribution with an id in state that has lost them is
 * reported as unowned and only taken over with `--adopt`.
 *
 * ### Creating a Distribution
 * **Example:** In front of any HTTP origin
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const cdn = yield* Stackit.CDN.Distribution("Cdn", {
 *   backend: { type: "http", originUrl: "https://origin.example.com" },
 * });
 * // cdn.url is the CDN's URL, on the hostname STACKIT assigned.
 * ```
 *
 * **Example:** In front of a private bucket
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const bucket = yield* Stackit.ObjectStorage.Bucket("Assets", {});
 * const group = yield* Stackit.ObjectStorage.CredentialsGroup("CdnReaders", {});
 * const key = yield* Stackit.ObjectStorage.AccessKey("CdnKey", {
 *   credentialsGroupId: group.credentialsGroupId,
 * });
 *
 * const cdn = yield* Stackit.CDN.Distribution("Cdn", {
 *   backend: {
 *     type: "bucket",
 *     bucketUrl: bucket.urlVirtualHostedStyle,
 *     region: bucket.region,
 *     credentials: {
 *       accessKeyId: key.accessKeyId,
 *       secretAccessKey: key.secretAccessKey,
 *     },
 *   },
 * });
 * ```
 *
 * **Example:** In front of a Function
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Output from "alchemy/Output";
 * import * as Config from "effect/Config";
 *
 * const images = yield* Stackit.ContainerRegistry.Project("Images", {});
 * const pusher = yield* Stackit.ContainerRegistry.RobotAccount("Pusher", {
 *   project: images.name,
 *   registryUrl: images.url,
 *   credentials: {
 *     username: Config.String("HARBOR_USERNAME"),
 *     secret: Config.Redacted("HARBOR_CLI_SECRET"),
 *   },
 * });
 * const puller = yield* Stackit.Functions.PullCredential("Puller", {
 *   address: images.registryHost,
 *   username: pusher.robotName,
 *   password: pusher.secret,
 * });
 * const api = yield* Stackit.Functions.Function("Api", {
 *   main: "./src/api.ts",
 *   registry: {
 *     repository: Output.interpolate`${images.imagePrefix}/api`,
 *     username: pusher.robotName,
 *     password: pusher.secret,
 *   },
 *   pullCredential: puller.pullCredentialId,
 * });
 *
 * // The Function's URL is the origin. The hostname stays the CDN's.
 * const cdn = yield* Stackit.CDN.Distribution("Cdn", {
 *   backend: { type: "http", originUrl: api.url.as<string>() },
 * });
 * ```
 *
 * **Example:** Sending some countries to another origin
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const cdn = yield* Stackit.CDN.Distribution("Cdn", {
 *   regions: ["EU", "US"],
 *   backend: {
 *     type: "http",
 *     originUrl: "https://eu.example.com",
 *     geofencing: { "https://us.example.com": ["US", "CA"] },
 *   },
 * });
 * ```
 *
 * ### Caching
 * **Example:** Cache for a day unless the origin says otherwise
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const cdn = yield* Stackit.CDN.Distribution("Cdn", {
 *   backend: { type: "http", originUrl: "https://origin.example.com" },
 *   defaultCacheDuration: "P1D",
 *   cacheConfig: {
 *     cacheKeyHeaders: ["Accept-Language"],
 *     queryStringVaryEnabled: true,
 *     queryStringVaryParameters: ["page"],
 *   },
 * });
 * ```
 *
 * **Example:** Optimize images and cap the monthly traffic
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const cdn = yield* Stackit.CDN.Distribution("Cdn", {
 *   backend: { type: "http", originUrl: "https://origin.example.com" },
 *   optimizer: { enabled: true },
 *   monthlyLimitBytes: 500_000_000_000,
 * });
 * ```
 *
 * ### Restricting Access
 * **Example:** Block countries and addresses
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const cdn = yield* Stackit.CDN.Distribution("Cdn", {
 *   backend: { type: "http", originUrl: "https://origin.example.com" },
 *   blockedCountries: ["KP"],
 *   blockedIps: ["203.0.113.7"],
 * });
 * ```
 *
 * **Example:** Run the web application firewall
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const cdn = yield* Stackit.CDN.Distribution("Cdn", {
 *   backend: { type: "http", originUrl: "https://origin.example.com" },
 *   waf: {
 *     mode: "LOG_ONLY",
 *     paranoiaLevel: "L1",
 *     enabledRuleCollectionIds: ["@builtin/crs/request"],
 *   },
 * });
 * ```
 *
 * ### Redirects
 * **Example:** Move a section of the site
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const cdn = yield* Stackit.CDN.Distribution("Cdn", {
 *   backend: { type: "http", originUrl: "https://origin.example.com" },
 *   redirects: {
 *     rules: [
 *       {
 *         targetUrl: "https://shop.example.com",
 *         statusCode: 301,
 *         matchers: [{ values: ["/shop/*"] }],
 *       },
 *     ],
 *   },
 * });
 * ```
 *
 * ### Shipping Logs
 * **Example:** Push access logs to Loki
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Config from "effect/Config";
 *
 * const password = yield* Config.redacted("LOKI_PASSWORD");
 * const cdn = yield* Stackit.CDN.Distribution("Cdn", {
 *   backend: { type: "http", originUrl: "https://origin.example.com" },
 *   logSink: {
 *     type: "loki",
 *     pushUrl: "https://loki.example.com/loki/api/v1/push",
 *     credentials: { username: "cdn", password },
 *   },
 * });
 * ```
 *
 * ### Runtime Operations
 * **Example:** Purge a path from a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Cdn = Stackit.CDN.Distribution("Cdn", {
 *   backend: { type: "http", originUrl: "https://origin.example.com" },
 * });
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const purgeCache = yield* Stackit.CDN.PurgeCache(yield* Cdn);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* purgeCache({ path: "/index.html" });
 *         return HttpServerResponse.text("purged");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.CDN.PurgeCacheHttp)),
 * ) {}
 * ```
 *
 * ### Replacement Cautions
 * **Example:** Moving to another project
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * // A new `projectId` creates a new distribution with a new hostname, then deletes
 * // the old one. Repoint any CNAME at the new `hostname`.
 * const cdn = yield* Stackit.CDN.Distribution("Cdn", {
 *   projectId: "11111111-1111-4111-8111-111111111111",
 *   backend: { type: "http", originUrl: "https://origin.example.com" },
 * });
 * ```
 *
 * @resource
 * @product STACKIT CDN
 * @category CDN
 */
export const Distribution = Resource<Distribution>("Stackit.CDN.Distribution");

const DEFAULT_REGIONS: NonNullable<DistributionProps["regions"]> = ["EU"];

/** What a removed WAF prop goes back to. The allow lists stay: an empty one is rejected. */
const WAF_RESET: Partial<DistributionWaf> = {
  mode: "DISABLED",
  type: "FREE",
  enabledRuleIds: [],
  disabledRuleIds: [],
  logOnlyRuleIds: [],
  enabledRuleGroupIds: [],
  disabledRuleGroupIds: [],
  logOnlyRuleGroupIds: [],
  enabledRuleCollectionIds: [],
  disabledRuleCollectionIds: [],
  logOnlyRuleCollectionIds: [],
};

const CACHE_RESET: Required<DistributionCacheConfig> = {
  cacheKeyHeaders: [],
  queryStringVaryEnabled: false,
  queryStringVaryParameters: [],
};

const TLS_RESET: Required<DistributionTls> = { enableTls10: false, enableTls11: false };

const toAttrs = (distribution: cdn.Distribution): DistributionAttributes => {
  // STACKIT gives every distribution one managed domain; it can only be missing from
  // a listing taken before the distribution finished creating.
  const hostname = distribution.domains.find((domain) => domain.type === "managed")?.name ?? "";
  return {
    distributionId: distribution.id,
    projectId: distribution.projectId,
    hostname,
    url: `https://${hostname}`,
    domains: distribution.domains.map((domain) => ({
      name: domain.name,
      type: domain.type,
      status: domain.status,
      certificateType: domain.certificateType,
    })),
    status: distribution.status,
    errors: toCdnErrors(distribution.errors),
    createdAt: distribution.createdAt,
    updatedAt: distribution.updatedAt,
    labels: stripInternalLabels(distribution.config.labels),
    config: distribution.config,
  };
};

/**
 * A distribution of this logical id. A replacement shares its logical id with the one
 * it replaces, and garbage collection deletes that one afterwards, so with `instanceId`
 * only this generation matches.
 */
const findOwned = (projectId: string, id: string, instanceId: string | undefined) =>
  Effect.gen(function* () {
    const distributions = yield* listAllDistributions(projectId);
    for (const distribution of distributions) {
      const labels = distribution.config.labels;
      if (instanceId !== undefined && !hasInstanceLabel(instanceId, labels)) continue;
      if (yield* hasAlchemyLabels(id, labels)) return distribution;
    }
    return undefined;
  });

/** Origins as STACKIT stores them: no path or query, `https` when no protocol is given. */
const originOf = (url: string): string => {
  const absolute = /^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url}`;
  return URL.canParse(absolute) ? new URL(absolute).origin : url;
};

const withoutTrailingSlash = (url: string): string => url.replace(/\/+$/, "");

/** The value the props set, else `reset` when the previous props set one, else nothing. */
const orReset = <T>(value: T | undefined, previous: unknown, reset: T): T | undefined =>
  value !== undefined ? value : previous !== undefined ? reset : undefined;

/**
 * The fields the props set, plus `reset` for each field the previous props set and these
 * don't. Nothing when neither set any.
 */
const orResetFields = <T extends object>(
  value: T | undefined,
  previous: T | undefined,
  reset: Partial<T>,
): Partial<T> | undefined => {
  if (value === undefined && previous === undefined) return undefined;
  const fields: Partial<T> = value === undefined ? { ...reset } : { ...value };
  for (const key of Object.keys(previous ?? {}) as Array<keyof T & string>) {
    if (value?.[key] === undefined && key in reset) fields[key] = reset[key];
  }
  return fields;
};

const sameGeofencing = (
  observed: Readonly<Record<string, ReadonlyArray<string> | undefined>> | undefined,
  desired: Readonly<Record<string, ReadonlyArray<string>>>,
): boolean => {
  const live = observed ?? {};
  return (
    sameMembers(Object.keys(live), Object.keys(desired)) &&
    Object.entries(desired).every(([origin, countries]) => sameMembers(live[origin], countries))
  );
};

/** The backend to PATCH, or nothing when the observed one already matches. */
const backendDelta = (
  observed: cdn.ConfigBackend,
  news: DistributionProps,
  olds: DistributionProps | undefined,
  createdNow: boolean,
): cdn.ConfigPatchBackend | undefined => {
  const desired = news.backend;
  if (desired.type === "http") {
    const previous = olds?.backend.type === "http" ? olds.backend : undefined;
    const headers = orReset(desired.originRequestHeaders, previous?.originRequestHeaders, {});
    const geofencing = orReset(desired.geofencing, previous?.geofencing, {});
    if (
      observed.type === "http" &&
      originOf(observed.originUrl) === originOf(desired.originUrl) &&
      (headers === undefined ||
        recordsEqual(
          Object.fromEntries(
            Object.entries(observed.originRequestHeaders ?? {}).filter(
              (entry): entry is [string, string] => entry[1] !== undefined,
            ),
          ),
          headers,
        )) &&
      (geofencing === undefined || sameGeofencing(observed.geofencing, geofencing))
    ) {
      return undefined;
    }
    return {
      type: "http",
      originUrl: desired.originUrl,
      ...(headers !== undefined ? { originRequestHeaders: headers } : {}),
      ...(geofencing !== undefined ? { geofencing } : {}),
    };
  }
  // Credentials can't be observed, so the previous props are all there is to compare.
  const previous = olds?.backend.type === "bucket" ? olds.backend : undefined;
  const newCredentials = !createdNow && secretsDiffer(desired.credentials, previous?.credentials);
  if (
    observed.type === "bucket" &&
    withoutTrailingSlash(observed.bucketUrl) === withoutTrailingSlash(desired.bucketUrl) &&
    observed.region === desired.region &&
    !newCredentials
  ) {
    return undefined;
  }
  return {
    type: "bucket",
    bucketUrl: desired.bucketUrl,
    region: desired.region,
    // A switch from another backend type needs them too.
    ...(newCredentials || observed.type !== "bucket" ? { credentials: desired.credentials } : {}),
  };
};

/** The delta between an observed configuration and the props, as a PATCH body. */
const configDelta = (
  observed: cdn.Config,
  news: DistributionProps,
  olds: DistributionProps | undefined,
  labels: Record<string, string>,
  createdNow: boolean,
): cdn.ConfigPatch => {
  const patch: cdn.ConfigPatch = {};

  const backend = backendDelta(observed.backend, news, olds, createdNow);
  if (backend !== undefined) patch.backend = backend;

  const regions = news.regions ?? DEFAULT_REGIONS;
  if (!sameMembers(observed.regions, regions)) patch.regions = [...regions];

  const blockedCountries = orReset(news.blockedCountries, olds?.blockedCountries, []);
  if (blockedCountries !== undefined && !sameMembers(observed.blockedCountries, blockedCountries)) {
    patch.blockedCountries = [...blockedCountries];
  }
  const blockedIps = orReset(news.blockedIps, olds?.blockedIps, []);
  if (blockedIps !== undefined && !sameMembers(observed.blockedIps, blockedIps)) {
    patch.blockedIps = [...blockedIps];
  }

  const duration = orReset<string | null>(
    news.defaultCacheDuration,
    olds?.defaultCacheDuration,
    null,
  );
  if (duration !== undefined && (observed.defaultCacheDuration ?? null) !== duration) {
    patch.defaultCacheDuration = duration;
  }
  const limit = orReset<number | null>(news.monthlyLimitBytes, olds?.monthlyLimitBytes, null);
  if (limit !== undefined && (observed.monthlyLimitBytes ?? null) !== limit) {
    patch.monthlyLimitBytes = limit;
  }

  const forwardHostHeader = orReset(news.forwardHostHeader, olds?.forwardHostHeader, false);
  if (forwardHostHeader !== undefined && observed.forwardHostHeader !== forwardHostHeader) {
    patch.forwardHostHeader = forwardHostHeader;
  }
  const stripResponseCookies = orReset(
    news.stripResponseCookies,
    olds?.stripResponseCookies,
    false,
  );
  if (
    stripResponseCookies !== undefined &&
    observed.stripResponseCookies !== stripResponseCookies
  ) {
    patch.stripResponseCookies = stripResponseCookies;
  }

  const cacheConfig = orResetFields(news.cacheConfig, olds?.cacheConfig, CACHE_RESET);
  if (cacheConfig !== undefined && !covers(cacheConfig, observed.cacheConfig)) {
    patch.cacheConfig = cacheConfig;
  }
  const optimizer = orReset(news.optimizer, olds?.optimizer, { enabled: false });
  if (optimizer !== undefined && !covers(optimizer, observed.optimizer)) {
    patch.optimizer = optimizer;
  }
  const tls = orResetFields(news.tls, olds?.tls, TLS_RESET);
  if (tls !== undefined && !covers(tls, observed.tls)) patch.tls = tls;
  const waf = orResetFields(news.waf, olds?.waf, WAF_RESET);
  if (waf !== undefined && !covers(waf, observed.waf)) patch.waf = waf;

  // Rules run in order, so unlike the other lists their order counts.
  const redirects = orReset(news.redirects, olds?.redirects, { rules: [] });
  const liveRules = observed.redirects?.rules ?? [];
  if (
    redirects !== undefined &&
    (redirects.rules.length !== liveRules.length ||
      !redirects.rules.every((rule, index) => covers(rule, liveRules[index])))
  ) {
    patch.redirects = redirects;
  }

  const logSink = news.logSink;
  if (logSink !== undefined) {
    if (
      observed.logSink?.type !== logSink.type ||
      observed.logSink.pushUrl !== logSink.pushUrl ||
      (!createdNow && secretsDiffer(logSink.credentials, olds?.logSink?.credentials))
    ) {
      patch.logSink = logSink;
    }
  } else if (olds?.logSink !== undefined && observed.logSink !== undefined) {
    patch.logSink = null;
  }

  // Labels are a JSON Merge Patch: null removes a key.
  const { upsert, removed } = diffLabels(observed.labels, labels);
  if (upsert.length > 0 || removed.length > 0) {
    patch.labels = {
      ...Object.fromEntries(upsert.map((label) => [label.Key, label.Value])),
      ...Object.fromEntries(removed.map((key) => [key, null])),
    };
  }

  return patch;
};

const waitForGone = (projectId: string, distributionId: string, startedDeleting: boolean) => {
  // An `ERROR` from before the delete can show once more. Only one seen after
  // `DELETING` is a failed delete.
  let sawDeleting = startedDeleting;
  return waitUntilGone({
    resource: `STACKIT CDN distribution ${distributionId}`,
    read: getDistributionOrUndefined(projectId, distributionId),
    failed: (distribution: cdn.Distribution) => {
      if (distribution.status === "DELETING") sawDeleting = true;
      return sawDeleting && distribution.status === "ERROR"
        ? errorSummary(distribution.errors, distribution.status)
        : undefined;
    },
    state: (distribution: cdn.Distribution) => distribution.status,
    timeout: CDN_TIMEOUT,
    ...CDN_POLL,
  });
};

export const DistributionProvider = () =>
  Provider.succeed(Distribution, {
    stables: ["distributionId", "projectId"],
    // Delete order: the distribution goes before the origin and key it uses.
    nuke: {
      dependsOn: [
        "Stackit.Functions.Function",
        "Stackit.ObjectStorage.AccessKey",
        "Stackit.ObjectStorage.Bucket",
      ],
    },

    list: Effect.fn(function* () {
      const env = yield* StackitEnvironment.current;
      const distributions = yield* listAllDistributions(env.projectId);
      return distributions
        .filter((distribution) => isAlchemyOwned(distribution.config.labels))
        .map(toAttrs);
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (output === undefined) return undefined;
      // The id is assigned by STACKIT, so the new distribution can't collide with the old.
      if (hasUnresolvedTrigger<DistributionProps>(news, ["projectId"])) {
        return { action: "replace", deleteFirst: false } as const;
      }
      const resolved = triggerProps<DistributionProps>(news);
      const env = yield* StackitEnvironment.current;
      if ((resolved.projectId ?? env.projectId) !== output.projectId) {
        return { action: "replace", deleteFirst: false } as const;
      }
      // Everything else updates in place (engine default: props changed).
      return undefined;
    }),

    read: Effect.fn(function* ({ id, instanceId, olds, output, previous }) {
      const env = yield* StackitEnvironment.current;
      const projectId = output?.projectId ?? olds?.projectId ?? env.projectId;
      let observed =
        output !== undefined
          ? yield* getDistributionOrUndefined(projectId, output.distributionId)
          : undefined;
      if (observed === undefined) {
        // A crashed create or lost state: find it by its labels.
        observed = yield* findOwned(
          projectId,
          id,
          readGeneration({ instanceId, output, previous }),
        );
      }
      // Going away: reconcile waits it out and creates a new one.
      if (observed === undefined || observed.status === "DELETING") return undefined;
      const attrs = toAttrs(observed);
      return (yield* hasAlchemyLabels(id, observed.config.labels)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, instanceId, news, olds, output }) {
      const env = yield* StackitEnvironment.current;
      const projectId = news.projectId ?? output?.projectId ?? env.projectId;
      const labels = yield* desiredGenerationLabels(id, instanceId, news.labels);

      // 1. Observe. `output` is a cache: its id only counts in the desired project.
      let current =
        output?.projectId === projectId
          ? yield* getDistributionOrUndefined(projectId, output.distributionId)
          : undefined;
      if (current === undefined) current = yield* findOwned(projectId, id, instanceId);
      if (current?.status === "DELETING") {
        yield* waitForGone(projectId, current.id, true);
        current = undefined;
      }

      // 2. Ensure.
      const createdNow = current === undefined;
      if (current === undefined) {
        const created = yield* cdn.createDistribution({
          projectId,
          // Dedupes a retry of a create whose state write crashed. A duplicate of the
          // intent is dropped, so a distribution deleted out of band can only be
          // recreated without one.
          ...(output ? {} : { intentId: instanceId }),
          backend: news.backend,
          regions: [...(news.regions ?? DEFAULT_REGIONS)],
          labels,
          blockedCountries: news.blockedCountries,
          blockedIps: news.blockedIps,
          cacheConfig: news.cacheConfig,
          defaultCacheDuration: news.defaultCacheDuration,
          forwardHostHeader: news.forwardHostHeader,
          logSink: news.logSink,
          monthlyLimitBytes: news.monthlyLimitBytes,
          optimizer: news.optimizer,
          redirects: news.redirects,
          stripResponseCookies: news.stripResponseCookies,
          ...(news.tls !== undefined ? { tls: { ...TLS_RESET, ...news.tls } } : {}),
          ...(news.waf !== undefined
            ? { waf: { type: "FREE", enabledRuleIds: [], ...news.waf } }
            : {}),
        });
        current = created.distribution;
      }

      const distributionId = current.id;
      const resource = `STACKIT CDN distribution ${distributionId}`;
      const read = cdn
        .getDistribution({ projectId, distributionId })
        .pipe(Effect.map(({ distribution }) => distribution));
      const beingDeleted = (distribution: cdn.Distribution) =>
        distribution.status === "DELETING" ? "it is being deleted" : undefined;

      // Wait out an in-flight create or update before comparing against it. `ERROR` isn't
      // failed here: the sync below re-submits the configuration, which may repair it.
      const settled =
        current.status === "ACTIVE" || current.status === "ERROR"
          ? current
          : yield* waitFor({
              resource,
              read,
              ready: (distribution) =>
                distribution.status === "ACTIVE" || distribution.status === "ERROR",
              failed: beingDeleted,
              state: (distribution) => distribution.status,
              timeout: CDN_TIMEOUT,
              ...CDN_POLL,
            });

      // 3. Sync. One PATCH holds every drifted aspect.
      const delta = configDelta(settled.config, news, olds, labels, createdNow);
      const inSync = Object.keys(delta).length === 0;

      // 4. Return, when there is nothing to change.
      if (inSync && settled.status === "ACTIVE") return toAttrs(settled);

      yield* cdn.patchDistribution({
        projectId,
        distributionId,
        // A distribution in `ERROR` is re-submitted even with nothing drifted, so it
        // either recovers or the deploy fails; it is never returned as healthy.
        config: inSync ? { regions: [...settled.config.regions] } : delta,
      });

      // A read right after the PATCH can still report the old status. `updatedAt` shows
      // the PATCH landed; a PATCH that leaves it alone gets a few polls instead.
      let polls = 0;
      const ready = yield* waitFor({
        resource,
        read,
        ready: (distribution) =>
          distribution.status === "ACTIVE" &&
          (distribution.updatedAt !== settled.updatedAt || polls > STALE_POLLS),
        failed: (distribution) => {
          polls++;
          return (
            beingDeleted(distribution) ??
            (distribution.status === "ERROR" && polls > STALE_POLLS
              ? errorSummary(distribution.errors, distribution.status)
              : undefined)
          );
        },
        state: (distribution) => distribution.status,
        timeout: CDN_TIMEOUT,
        ...CDN_POLL,
      });
      return toAttrs(ready);
    }),

    delete: Effect.fn(function* ({ output }) {
      const current = yield* getDistributionOrUndefined(output.projectId, output.distributionId);
      if (current === undefined) return;
      if (current.status !== "DELETING") {
        yield* cdn.deleteDistribution({
          projectId: output.projectId,
          distributionId: output.distributionId,
        });
      }
      yield* waitForGone(output.projectId, output.distributionId, current.status === "DELETING");
    }),
  });
