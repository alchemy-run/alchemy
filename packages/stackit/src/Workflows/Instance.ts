import * as workflows from "@distilled.cloud/stackit/workflows";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import { StackitEnvironment } from "../Environment.ts";
import { resolveProjectScope, type ProjectScope } from "../IaaS/internal.ts";
import { hasUnresolvedTrigger, rawProp, triggerProps } from "../internal/diff.ts";
import { secretsDiffer } from "../internal/equal.ts";
import type { Providers } from "../Providers.ts";
import {
  airflowMajorVersion,
  conflictRetry,
  DagBundleTypeChange,
  DagSourceNotSupported,
  findInstanceByName,
  generatedDisplayName,
  getInstanceOrUndefined,
  latestVersion,
  listOwnedInstances,
  requestScope,
  settleInstance,
  waitForInstance,
  waitForInstanceGone,
} from "./internal.ts";

/** A secret or identifier the API takes as text, which a prop can keep `Redacted`. */
type Secret = string | Redacted.Redacted<string>;

/** How users and API clients sign in to Airflow. */
export type InstanceIdentityProvider =
  | {
      /** STACKIT's own identity provider. */
      type: "stackit";
    }
  | {
      /** An OpenID Connect provider of your own. */
      type: "oauth2";
      /**
       * The provider's name in the instance. `azure`, `okta`, `aws_cognito` and `keycloak` change
       * how a token is parsed, so use the matching one.
       */
      name: string;
      /** Id of the Workflows application at the provider. */
      clientId: string;
      /** Secret of the Workflows application. STACKIT never returns it. */
      clientSecret: Secret;
      /** The provider's OpenID configuration, ending in `/.well-known/openid-configuration`. */
      discoveryEndpoint: string;
      /** Scopes to request when a user logs in to the UI, such as `openid email`. */
      scope: string;
      /**
       * Audiences an API token may carry. Airflow's REST API is only reachable once this is set,
       * so the `Stackit.Workflows` bindings on Airflow need it.
       */
      apiAudience?: string[];
      /** RFC 8707 resource to request tokens for. */
      resource?: string;
      /** Dot-separated path to the roles in the token, such as `realm_access.roles`. */
      rolesClaim?: string;
    };

/** Credentials of a Git repository. */
export type GitAuth =
  | {
      /** A public repository. */
      type: "none";
    }
  | {
      /** A username with a password or token. */
      type: "basic";
      /** The username. */
      username: string;
      /** The password or token. STACKIT never returns it. */
      password: Secret;
    };

/** Credentials of an S3-compatible bucket. */
export type S3Auth =
  | {
      /** A public bucket. */
      type: "none";
    }
  | {
      /** An access key. */
      type: "accessKey";
      /** The access key's id. */
      accessKeyId: Secret;
      /** The access key's secret. STACKIT never returns it. */
      secretAccessKey: Secret;
    };

/** A Git repository to load DAGs from. */
export interface GitDagBundle {
  /** Bundle type. Changing it needs another bundle on the instance, or a new name. */
  type: "git";
  /** Unique name in the instance: a DNS label starting with a letter, up to 63 characters. */
  name: string;
  /** URL of the repository. */
  url: string;
  /** Branch, tag or ref to track. */
  branch: string;
  /** How to read the repository. */
  auth: GitAuth;
  /** Directory holding the DAG files. @default the repository's root */
  subdir?: string;
  /** Seconds between checks for new commits. @default 60 */
  refreshInterval?: number;
}

/** An S3-compatible bucket to load DAGs from, such as a `Stackit.ObjectStorage.Bucket`. */
export interface S3DagBundle {
  /** Bundle type. Changing it needs another bundle on the instance, or a new name. */
  type: "s3";
  /** Unique name in the instance: a DNS label starting with a letter, up to 63 characters. */
  name: string;
  /** Name of the bucket. */
  bucketName: string;
  /** How to read the bucket. */
  s3Auth: S3Auth;
  /** S3 endpoint URL. @default the Object Storage endpoint of the instance's region */
  endpoint?: string;
  /** Key prefix holding the DAG files. @default the bucket's root */
  prefix?: string;
  /** Seconds between checks for new objects. @default 60 */
  refreshInterval?: number;
}

/** Where an instance loads DAGs from. */
export type DagBundle = GitDagBundle | S3DagBundle;

/** The Git repository an Airflow 2 instance loads DAGs from. */
export interface DagsRepository {
  /** URL of the repository. */
  url: string;
  /** Branch to use. */
  branch: string;
  /** How to read the repository. */
  auth: GitAuth;
}

export interface InstanceProps {
  /**
   * Display name, up to 25 lowercase letters, numbers and hyphens. STACKIT's docs say it becomes
   * part of the instance's URL, so `url` can change with it. Updates in place. Replacing an
   * instance with an explicit name deletes the old one first.
   *
   * @default a unique name generated from the stack, stage and logical ID
   */
  displayName?: string;
  /** Description, up to 256 characters. An empty string removes it; omit it to leave it alone. */
  description?: string;
  /**
   * STACKIT Workflows version, such as `workflows-3.0-airflow-3.1`. A change within one Airflow
   * major version updates in place. **A change of Airflow major version replaces the instance**,
   * because STACKIT doesn't upgrade across one, and the replacement starts with no run history.
   * Omitting it on a new instance takes the newest supported version, and a later deploy leaves
   * it there.
   *
   * @default the newest supported version
   */
  version?: string;
  /**
   * How users and API clients sign in. Updates in place. Omit it to leave the live setting alone;
   * a new instance without it gets the API's default.
   */
  identityProvider?: InstanceIdentityProvider;
  /**
   * Where the instance loads DAGs from, up to 10 sources, on Airflow 3. Updates in place, and
   * replaces the whole list: a bundle not listed is deleted. Omit it to leave the live list alone.
   * An instance keeps at least one bundle, so emptying the list fails.
   */
  dagBundles?: DagBundle[];
  /**
   * The Git repository to load DAGs from, on Airflow 2. Updates in place. On Airflow 3, use
   * `dagBundles`: this fails there.
   */
  dagsRepository?: DagsRepository;
  /**
   * The STACKIT network the instance runs in. **Changing it replaces the instance**, because the
   * API has no update for it, and the replacement starts with no run history.
   */
  network?: {
    /** Id of the network. */
    id: string;
  };
  /** Id of a `Stackit.Observability.Instance` to send metrics to. Omit it to leave it alone. */
  observabilityId?: string;
  /** Load Airflow's built-in example DAGs, on Airflow 3. Omit it to leave it alone. @default false */
  enableAirflowExampleDags?: boolean;
  /** Load STACKIT's sample DAGs, on Airflow 3. Omit it to leave it alone. @default false */
  enableStackitExampleDags?: boolean;
  /**
   * Project that owns the instance. **Changing it replaces the instance**, and the replacement
   * starts with no run history. @default the profile's project
   */
  projectId?: string;
  /**
   * Region of the instance. **Changing it replaces the instance**, and the replacement starts
   * with no run history. @default the profile's region
   */
  region?: string;
}

/** How users and API clients sign in, as STACKIT reports it: never with a client secret. */
export interface InstanceIdentityProviderAttributes {
  /** `stackit` or `oauth2`. */
  type: string;
  /** The provider's name in the instance, for `oauth2`. */
  name?: string;
  /** Id of the Workflows application, for `oauth2`. */
  clientId?: string;
  /** The provider's OpenID configuration, for `oauth2`. */
  discoveryEndpoint?: string;
  /** Scopes requested at login, for `oauth2`. */
  scope?: string;
  /** Audiences an API token may carry, for `oauth2`. */
  apiAudience?: string[];
  /** RFC 8707 resource, for `oauth2`. */
  resource?: string;
  /** Dot-separated path to the roles in the token, for `oauth2`. */
  rolesClaim?: string;
}

/** Credentials, as STACKIT reports them: no secrets, and here no key id either. */
export interface DagSourceAuthAttributes {
  /** `none`, `basic` or `accessKey`. */
  type: string;
  /** The username, for `basic`. */
  username?: string;
}

/** A DAG bundle, without its secrets. */
export interface DagBundleAttributes {
  /** `git` or `s3`. */
  type: string;
  /** Unique name in the instance. */
  name: string;
  /** How the source is read. */
  auth: DagSourceAuthAttributes;
  /** Seconds between checks for changes. */
  refreshInterval?: number;
  /** URL of the repository, for `git`. */
  url?: string;
  /** Branch, tag or ref, for `git`. */
  branch?: string;
  /** Directory holding the DAG files, for `git`. */
  subdir?: string;
  /** Name of the bucket, for `s3`. */
  bucketName?: string;
  /** S3 endpoint, for `s3`. */
  endpoint?: string;
  /** Key prefix holding the DAG files, for `s3`. */
  prefix?: string;
}

/** An Airflow 2 instance's repository, without its secrets. */
export interface DagsRepositoryAttributes {
  /** URL of the repository. */
  url: string;
  /** Branch in use. */
  branch: string;
  /** How the repository is read. */
  auth: DagSourceAuthAttributes;
}

export interface InstanceAttributes {
  /** STACKIT instance id. Stable across updates. */
  instanceId: string;
  /** Project that owns the instance. */
  projectId: string;
  /** Region of the instance. */
  region: string;
  /** Display name. */
  displayName: string;
  /** Description. */
  description: string | undefined;
  /** STACKIT Workflows version. */
  version: string;
  /** Instance status; `active` after a deploy. */
  status: string;
  /** What the status means, when the API says. */
  statusMessage: string | undefined;
  /** The URL of Airflow's UI, which serves its REST API too. */
  url: string;
  /** The callback URL to register with your identity provider. */
  redirectUrl: string;
  /** How users and API clients sign in. */
  identityProvider: InstanceIdentityProviderAttributes;
  /** Configured DAG bundles, on Airflow 3. */
  dagBundles: DagBundleAttributes[];
  /** Configured Git repository, on Airflow 2. */
  dagsRepository: DagsRepositoryAttributes | undefined;
  /** Id of the network the instance runs in. */
  networkId: string | undefined;
  /** Id of the Observability instance receiving metrics. */
  observabilityId: string | undefined;
  /** Whether Airflow's built-in example DAGs are loaded. */
  enableAirflowExampleDags: boolean | undefined;
  /** Whether STACKIT's sample DAGs are loaded. */
  enableStackitExampleDags: boolean | undefined;
  /** When the instance's creation was triggered. */
  createdAt: string;
}

export type Instance = Resource<
  "Stackit.Workflows.Instance",
  InstanceProps,
  InstanceAttributes,
  never,
  Providers
>;

/**
 * A STACKIT Workflows instance: **managed Apache Airflow**. It runs Python DAGs that it loads from
 * Git or S3, each task in a Kubernetes pod.
 *
 * This is not `alchemy/Workflows`, and it doesn't run Effect workflows: STACKIT has no durable code
 * engine for them. A Worker or Function can trigger and read DAG runs through the bindings in this
 * namespace.
 *
 * Display name, description, a version within one Airflow major version, the identity provider, DAG
 * sources, Observability and the example flags update in place. Changing the Airflow major version,
 * the network, the project or the region replaces the instance, and **replacing an instance loses
 * what lives in it**: DAG run history, XComs, variables and connections. Your DAG files stay in
 * their source. To change a bundle between Git and S3, keep another bundle on the instance or give
 * it a new name, because the API can't change a bundle's type and an instance keeps at least one.
 *
 * STACKIT charges for an instance, and for each task's pod by its CPU, memory and duration. It
 * publishes no rate: the portal's order flow shows it.
 *
 * The API has no labels. Alchemy tells its own instance by the id in state, or by a generated name,
 * so an instance found by an explicit name without state is reported as unowned, and only taken
 * over with `--adopt`. `alchemy unsafe nuke` deletes every instance whose display name has the shape
 * of a generated one: choose another shape for an instance that must survive a nuke.
 *
 * See [STACKIT's Workflows docs](https://docs.stackit.cloud/products/data-and-ai/workflows/).
 *
 * :::caution[STACKIT Workflows is an alpha API]
 * STACKIT serves this API as `v1alpha`, so it may change.
 * :::
 *
 * :::caution[Changing the Airflow major version of `version`, `network`, `projectId` or `region` replaces the Instance]
 * Replacing an instance loses what lives in it: DAG run history, XComs, variables and
 * connections. Your DAG files stay in their source.
 * :::
 *
 * ### Creating an Instance
 * **Example:** Load DAGs from a public Git repository
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const airflow = yield* Stackit.Workflows.Instance("Airflow", {
 *   displayName: "reports",
 *   version: "workflows-3.0-airflow-3.1",
 *   dagBundles: [
 *     {
 *       type: "git",
 *       name: "reports",
 *       url: "https://github.com/acme/reports-dags",
 *       branch: "main",
 *       subdir: "dags",
 *       auth: { type: "none" },
 *     },
 *   ],
 * });
 * // airflow.url is the UI
 * ```
 *
 * ### Loading DAGs
 * **Example:** Load DAGs from a private repository
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Config from "effect/Config";
 *
 * const airflow = yield* Stackit.Workflows.Instance("Airflow", {
 *   dagBundles: [
 *     {
 *       type: "git",
 *       name: "reports",
 *       url: "https://github.com/acme/reports-dags",
 *       branch: "main",
 *       auth: {
 *         type: "basic",
 *         username: "airflow",
 *         password: Config.Redacted("DAGS_REPOSITORY_TOKEN"),
 *       },
 *     },
 *   ],
 * });
 * ```
 *
 * **Example:** Load DAGs from a bucket
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Config from "effect/Config";
 *
 * const airflow = yield* Stackit.Workflows.Instance("Airflow", {
 *   dagBundles: [
 *     {
 *       type: "s3",
 *       name: "reports",
 *       bucketName: "acme-reports-dags",
 *       prefix: "dags/",
 *       s3Auth: {
 *         type: "accessKey",
 *         accessKeyId: Config.Redacted("DAGS_ACCESS_KEY_ID"),
 *         secretAccessKey: Config.Redacted("DAGS_SECRET_ACCESS_KEY"),
 *       },
 *     },
 *   ],
 * });
 * ```
 *
 * ### Signing In
 * **Example:** Your own identity provider, with the REST API on
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Config from "effect/Config";
 *
 * const airflow = yield* Stackit.Workflows.Instance("Airflow", {
 *   identityProvider: {
 *     type: "oauth2",
 *     name: "keycloak",
 *     clientId: "workflows",
 *     clientSecret: Config.Redacted("WORKFLOWS_OIDC_CLIENT_SECRET"),
 *     discoveryEndpoint: "https://login.example.com/realms/acme/.well-known/openid-configuration",
 *     scope: "openid email",
 *     rolesClaim: "resource_access.workflows.roles",
 *     apiAudience: ["workflows-api"],
 *   },
 * });
 * // Register airflow.redirectUrl with the identity provider.
 * ```
 *
 * ### Triggering a DAG from a Runtime
 * **Example:** Start a run from a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Config from "effect/Config";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Airflow = Stackit.Workflows.Instance("Airflow", {});
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const airflow = yield* Airflow;
 *     const trigger = yield* Stackit.Workflows.TriggerDagRun(airflow, {
 *       discoveryEndpoint: "https://login.example.com/realms/acme/.well-known/openid-configuration",
 *       clientId: "reports-api",
 *       clientSecret: yield* Config.Redacted("AIRFLOW_CLIENT_SECRET"),
 *     });
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const run = yield* trigger({ dag_id: "reports", conf: { day: "2026-11-01" } });
 *         return yield* HttpServerResponse.json({ runId: run.dag_run_id });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Workflows.TriggerDagRunHttp)),
 * ) {}
 * ```
 *
 * @resource
 * @product STACKIT Workflows
 * @category Workflows
 */
export const Instance = Resource<Instance>("Stackit.Workflows.Instance");

/** The spec's default for a bundle's `refreshInterval`, which the API fills in. */
const DEFAULT_REFRESH_INTERVAL = 60;

const reveal = (value: Secret | undefined) =>
  Redacted.isRedacted(value) ? Redacted.value(value) : value;

/** Leading and trailing slashes don't count in a `subdir`, as the spec says. */
const normalizeSubdir = (subdir: string | undefined) => (subdir ?? "").replace(/^\/+|\/+$/g, "");

/** An endpoint's host and path, so that `https://` or a trailing slash isn't a difference. */
const normalizeEndpoint = (endpoint: string | undefined) =>
  (endpoint ?? "").replace(/^https?:\/\//, "").replace(/\/+$/, "");

/** The region's own endpoint: the API's default names `eu01`, whatever the instance's region. */
const defaultS3Endpoint = (region: string) => `https://object.storage.${region}.onstackit.cloud`;

/** `auth` or `s3Auth` as the API reports it, whichever member of the union it is. */
const observedAuth = (auth: { readonly type?: string | undefined }) =>
  auth as {
    readonly type?: string;
    readonly username?: string;
    readonly accessKeyId?: Secret;
  };

const toAuthAttributes = (auth: { readonly type?: string | undefined }) => {
  const { type, username } = observedAuth(auth);
  return { type: type ?? "none", ...(username === undefined ? {} : { username }) };
};

const toIdentityProviderAttributes = (
  observed: workflows.IdentityProvider,
): InstanceIdentityProviderAttributes => {
  if (observed.type !== "oauth2") return { type: observed.type };
  return {
    type: observed.type,
    name: observed.name,
    clientId: observed.clientId,
    discoveryEndpoint: observed.discoveryEndpoint,
    scope: observed.scope,
    ...(observed.apiAudience === undefined ? {} : { apiAudience: [...observed.apiAudience] }),
    ...(observed.resource === undefined ? {} : { resource: observed.resource }),
    ...(observed.rolesClaim === undefined ? {} : { rolesClaim: observed.rolesClaim }),
  };
};

const toBundleAttributes = (
  bundle: workflows.DagBundle | workflows.DagBundleResponseOutput,
): DagBundleAttributes =>
  bundle.type === "git"
    ? {
        type: bundle.type,
        name: bundle.name,
        auth: toAuthAttributes(bundle.auth),
        url: bundle.url,
        branch: bundle.branch,
        ...(bundle.subdir === undefined ? {} : { subdir: bundle.subdir }),
        ...(bundle.refreshInterval === undefined
          ? {}
          : { refreshInterval: bundle.refreshInterval }),
      }
    : {
        type: bundle.type,
        name: bundle.name,
        auth: toAuthAttributes(bundle.s3Auth),
        bucketName: bundle.bucketName,
        ...(bundle.endpoint === undefined ? {} : { endpoint: bundle.endpoint }),
        ...(bundle.prefix === undefined ? {} : { prefix: bundle.prefix }),
        ...(bundle.refreshInterval === undefined
          ? {}
          : { refreshInterval: bundle.refreshInterval }),
      };

const toAttrs = (scope: ProjectScope, instance: workflows.Instance): InstanceAttributes => ({
  instanceId: instance.id,
  projectId: scope.projectId,
  region: scope.region,
  displayName: instance.displayName,
  description: instance.description,
  version: instance.version,
  status: instance.status,
  statusMessage: instance.statusMessage,
  url: instance.endpoints.url,
  redirectUrl: instance.endpoints.redirectUrl,
  identityProvider: toIdentityProviderAttributes(instance.identityProvider),
  dagBundles: (instance.dagBundles ?? []).map(toBundleAttributes),
  dagsRepository:
    instance.dagsRepository === undefined
      ? undefined
      : {
          url: instance.dagsRepository.url,
          branch: instance.dagsRepository.branch,
          auth: toAuthAttributes(instance.dagsRepository.auth),
        },
  networkId: instance.network?.id,
  observabilityId: instance.observabilityId,
  enableAirflowExampleDags: instance.enableAirflowExampleDags,
  enableStackitExampleDags: instance.enableStackitExampleDags,
  createdAt: instance.createdAt,
});

/** The secret of a bundle or repository's credentials, which the API never returns. */
const authSecretOf = (auth: GitAuth | S3Auth) =>
  auth.type === "basic"
    ? auth.password
    : auth.type === "accessKey"
      ? auth.secretAccessKey
      : undefined;

const bundleSecretOf = (bundle: DagBundle) =>
  authSecretOf(bundle.type === "git" ? bundle.auth : bundle.s3Auth);

/**
 * Every secret in the props, to compare two deploys of them. A `Redacted` serializes to a fixed
 * marker, so the engine's default comparison can't see a new one.
 */
const secretsOf = (props: InstanceProps) => ({
  clientSecret:
    props.identityProvider?.type === "oauth2" ? props.identityProvider.clientSecret : undefined,
  bundles: (props.dagBundles ?? []).map((bundle) => [
    bundle.name,
    bundleSecretOf(bundle),
    bundle.type === "s3" && bundle.s3Auth.type === "accessKey"
      ? bundle.s3Auth.accessKeyId
      : undefined,
  ]),
  repository:
    props.dagsRepository === undefined ? undefined : authSecretOf(props.dagsRepository.auth),
});

/** What the API takes for a bundle, with the region's own endpoint when none is set. */
const toBundleInput = (bundle: DagBundle, region: string): workflows.DagBundle =>
  bundle.type === "git"
    ? {
        type: "git",
        name: bundle.name,
        url: bundle.url,
        branch: bundle.branch,
        auth: bundle.auth,
        ...(bundle.subdir === undefined ? {} : { subdir: bundle.subdir }),
        ...(bundle.refreshInterval === undefined
          ? {}
          : { refreshInterval: bundle.refreshInterval }),
      }
    : {
        type: "s3",
        name: bundle.name,
        bucketName: bundle.bucketName,
        s3Auth: bundle.s3Auth,
        endpoint: bundle.endpoint ?? defaultS3Endpoint(region),
        ...(bundle.prefix === undefined ? {} : { prefix: bundle.prefix }),
        ...(bundle.refreshInterval === undefined
          ? {}
          : { refreshInterval: bundle.refreshInterval }),
      };

/** The parts of a live bundle a prop can set, comparable as text. Never logged. */
const observedBundleKey = (bundle: workflows.DagBundleResponseOutput): string =>
  JSON.stringify(
    bundle.type === "git"
      ? [
          bundle.url,
          bundle.branch,
          normalizeSubdir(bundle.subdir),
          bundle.refreshInterval ?? DEFAULT_REFRESH_INTERVAL,
          observedAuth(bundle.auth).type ?? "none",
          observedAuth(bundle.auth).username,
        ]
      : [
          bundle.bucketName,
          normalizeEndpoint(bundle.endpoint),
          bundle.prefix ?? "",
          bundle.refreshInterval ?? DEFAULT_REFRESH_INTERVAL,
          observedAuth(bundle.s3Auth).type ?? "none",
          reveal(observedAuth(bundle.s3Auth).accessKeyId),
        ],
  );

/** {@link observedBundleKey} for a prop. The secret can't be observed, so it's left out. */
const desiredBundleKey = (bundle: DagBundle, region: string): string =>
  JSON.stringify(
    bundle.type === "git"
      ? [
          bundle.url,
          bundle.branch,
          normalizeSubdir(bundle.subdir),
          bundle.refreshInterval ?? DEFAULT_REFRESH_INTERVAL,
          bundle.auth.type,
          bundle.auth.type === "basic" ? bundle.auth.username : undefined,
        ]
      : [
          bundle.bucketName,
          normalizeEndpoint(bundle.endpoint ?? defaultS3Endpoint(region)),
          bundle.prefix ?? "",
          bundle.refreshInterval ?? DEFAULT_REFRESH_INTERVAL,
          bundle.s3Auth.type,
          bundle.s3Auth.type === "accessKey" ? reveal(bundle.s3Auth.accessKeyId) : undefined,
        ],
  );

/**
 * The full update for a bundle. The API wants credentials again whenever the source changes, and
 * clears `subdir` and `prefix` on an empty string, so all of it goes out.
 */
const toBundleUpdate = (bundle: DagBundle, region: string): workflows.UpdateDagBundlePayload =>
  bundle.type === "git"
    ? {
        type: "git",
        url: bundle.url,
        branch: bundle.branch,
        auth: bundle.auth,
        subdir: bundle.subdir ?? "",
        refreshInterval: bundle.refreshInterval ?? DEFAULT_REFRESH_INTERVAL,
      }
    : {
        type: "s3",
        bucketName: bundle.bucketName,
        s3Auth: bundle.s3Auth,
        endpoint: bundle.endpoint ?? defaultS3Endpoint(region),
        prefix: bundle.prefix ?? "",
        refreshInterval: bundle.refreshInterval ?? DEFAULT_REFRESH_INTERVAL,
      };

/** The parts of a live identity provider a prop can set, comparable as text. */
const observedIdentityProviderKey = (observed: workflows.IdentityProvider): string =>
  JSON.stringify(
    observed.type === "oauth2"
      ? [
          observed.type,
          observed.name,
          observed.clientId,
          observed.discoveryEndpoint,
          observed.scope,
          [...(observed.apiAudience ?? [])].sort(),
          observed.resource ?? "",
          observed.rolesClaim ?? "",
        ]
      : [observed.type],
  );

/** {@link observedIdentityProviderKey} for a prop. The secret can't be observed: it's left out. */
const desiredIdentityProviderKey = (desired: InstanceIdentityProvider): string =>
  JSON.stringify(
    desired.type === "oauth2"
      ? [
          desired.type,
          desired.name,
          desired.clientId,
          desired.discoveryEndpoint,
          desired.scope,
          [...(desired.apiAudience ?? [])].sort(),
          desired.resource ?? "",
          desired.rolesClaim ?? "",
        ]
      : [desired.type],
  );

/**
 * The full update for an identity provider. The API wants the secret again whenever the client or
 * discovery endpoint changes, and clears `resource`, `rolesClaim` and `apiAudience` on an empty
 * value, so all of it goes out.
 */
const toIdentityProviderUpdate = (
  desired: InstanceIdentityProvider,
): workflows.UpdateIdentityProviderPayload =>
  desired.type === "oauth2"
    ? {
        type: "oauth2",
        name: desired.name,
        clientId: desired.clientId,
        clientSecret: desired.clientSecret,
        discoveryEndpoint: desired.discoveryEndpoint,
        scope: desired.scope,
        apiAudience: desired.apiAudience ?? [],
        resource: desired.resource ?? "",
        rolesClaim: desired.rolesClaim ?? "",
      }
    : { type: "stackit" };

/** The parts of a live repository a prop can set, comparable as text. */
const observedRepositoryKey = (observed: workflows.GitRepository | undefined): string =>
  JSON.stringify(
    observed === undefined
      ? undefined
      : [
          observed.url,
          observed.branch,
          observedAuth(observed.auth).type ?? "none",
          observedAuth(observed.auth).username,
        ],
  );

const desiredRepositoryKey = (desired: DagsRepository): string =>
  JSON.stringify([
    desired.url,
    desired.branch,
    desired.auth.type,
    desired.auth.type === "basic" ? desired.auth.username : undefined,
  ]);

/** Refuse a DAG source the API only reads on the other Airflow major version. */
const assertDagSourceSupported = (news: InstanceProps, version: string) =>
  Effect.gen(function* () {
    const major = airflowMajorVersion(version);
    if (major === undefined) return;
    if (news.dagBundles !== undefined && major < 3) {
      return yield* new DagSourceNotSupported({
        version,
        message: `\`dagBundles\` needs Airflow 3, and version ${version} is Airflow ${major}: use \`dagsRepository\`.`,
      });
    }
    if (news.dagsRepository !== undefined && major >= 3) {
      return yield* new DagSourceNotSupported({
        version,
        message: `\`dagsRepository\` needs Airflow 2, and version ${version} is Airflow ${major}: use \`dagBundles\`.`,
      });
    }
  });

export const InstanceProvider = () =>
  Provider.succeed(Instance, {
    stables: ["instanceId", "projectId", "region", "createdAt"],

    list: Effect.fn(function* () {
      const env = yield* StackitEnvironment.current;
      const scope = { projectId: env.projectId, region: env.region };
      const instances = yield* listOwnedInstances(scope);
      return instances.map((instance) => toAttrs(scope, instance));
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (output === undefined) return undefined;
      // Nothing but a name holds the replacement back, and only an explicit one: a generated
      // name carries the generation, so it can't collide.
      const explicitName = rawProp<InstanceProps>(news, "displayName");
      if (hasUnresolvedTrigger<InstanceProps>(news, ["projectId", "region", "network"])) {
        return { action: "replace", deleteFirst: explicitName !== undefined } as const;
      }
      const resolved = triggerProps<InstanceProps>(news);
      const scope = yield* resolveProjectScope(resolved, undefined);
      if (scope.projectId !== output.projectId || scope.region !== output.region) {
        return { action: "replace", deleteFirst: false } as const;
      }
      // A new name doesn't collide with the old instance, so that one can stay until the new
      // one is up.
      const nameChanged = typeof explicitName === "string" && explicitName !== output.displayName;
      const deleteFirst = explicitName !== undefined && !nameChanged;
      // Compared with the props last deployed where there are any: the API may place an instance
      // on a network the props never asked for, and an unchanged deploy must not replace, and so
      // empty, the instance. Only an adoption has nothing but the live values, where a prop that
      // is unset keeps what the instance has.
      const networkChanged =
        olds !== undefined
          ? resolved.network?.id !== olds.network?.id
          : resolved.network?.id !== undefined && resolved.network.id !== output.networkId;
      if (networkChanged) return { action: "replace", deleteFirst } as const;
      // STACKIT doesn't upgrade across an Airflow major version. An unresolved version isn't
      // proof of a change, so it goes to the update, which the API refuses if it has to.
      const version = rawProp<InstanceProps>(news, "version");
      if (typeof version === "string") {
        const desired = airflowMajorVersion(version);
        const deployed = airflowMajorVersion(olds?.version ?? output.version);
        if (desired !== undefined && deployed !== undefined && desired !== deployed) {
          return { action: "replace", deleteFirst } as const;
        }
      }
      // A `Redacted` serializes to a fixed marker, so the engine's default comparison can't see a
      // new secret, and the API never returns the old one.
      if (
        isResolved(news) &&
        olds !== undefined &&
        secretsDiffer(secretsOf(news), secretsOf(olds))
      ) {
        return { action: "update" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output, previous }) {
      const scope = yield* resolveProjectScope(olds, output);
      if (output?.instanceId !== undefined) {
        const byId = yield* getInstanceOrUndefined(scope, output.instanceId);
        if (byId !== undefined && byId.status !== "deleting") return toAttrs(scope, byId);
      }
      const generated = yield* generatedDisplayName(id);
      const name = output?.displayName ?? olds?.displayName ?? generated;
      const found = yield* findInstanceByName(scope, name);
      if (found === undefined || found.status === "deleting") return undefined;
      const attrs = toAttrs(scope, found);
      // No labels: a generated name holds this generation's id, so it is ours. An explicit name
      // proves nothing, unless it is the generation being replaced, in the same scope.
      const isPrevious =
        previous?.instanceId === found.id &&
        previous.projectId === scope.projectId &&
        previous.region === scope.region;
      return name === generated || isPrevious ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, olds, output }) {
      const scope = yield* resolveProjectScope(news, output);
      const generated = yield* generatedDisplayName(id);
      const displayName = news.displayName ?? output?.displayName ?? generated;

      // 1. Observe — `output` is a cache for the id, and only names the desired instance while
      // it sits in the same project and region. Without it, only this generation's generated
      // name can be claimed.
      let observed: workflows.Instance | undefined;
      if (
        output?.instanceId !== undefined &&
        output.projectId === scope.projectId &&
        output.region === scope.region
      ) {
        observed = yield* getInstanceOrUndefined(scope, output.instanceId);
      }
      if (observed === undefined && displayName === generated) {
        observed = yield* findInstanceByName(scope, displayName);
      }
      // A delete in flight (an interrupted destroy): let it finish.
      if (observed?.status === "deleting") {
        yield* waitForInstanceGone(scope, observed.id);
        observed = undefined;
      }

      // 2. Ensure
      const created = observed === undefined;
      if (observed === undefined) {
        const version = news.version ?? (yield* latestVersion(scope.region));
        yield* assertDagSourceSupported(news, version);
        observed = yield* workflows.createInstance({
          ...requestScope(scope),
          displayName,
          version,
          ...(news.description === undefined ? {} : { description: news.description }),
          ...(news.identityProvider === undefined
            ? {}
            : { identityProvider: news.identityProvider }),
          ...(news.dagBundles === undefined
            ? {}
            : { dagBundles: news.dagBundles.map((b) => toBundleInput(b, scope.region)) }),
          ...(news.dagsRepository === undefined ? {} : { dagsRepository: news.dagsRepository }),
          ...(news.network === undefined ? {} : { network: { id: news.network.id } }),
          ...(news.observabilityId === undefined ? {} : { observabilityId: news.observabilityId }),
          ...(news.enableAirflowExampleDags === undefined
            ? {}
            : { enableAirflowExampleDags: news.enableAirflowExampleDags }),
          ...(news.enableStackitExampleDags === undefined
            ? {}
            : { enableStackitExampleDags: news.enableStackitExampleDags }),
        });
      }
      const liveId = observed.id;
      // An update can repair a failed instance, so settling only waits out a change in flight,
      // and the wait at the end decides.
      let live = yield* settleInstance(scope, liveId).pipe(
        // A read straight after the create can miss the new instance.
        Effect.retry({
          while: (error) => created && error._tag === "NotFound",
          schedule: Schedule.spaced("5 seconds"),
          times: 6,
        }),
      );
      yield* assertDagSourceSupported(news, news.version ?? live.version);

      // 3. Sync — observed values against the desired ones. STACKIT's docs say an instance only
      // takes changes while `active`, and each one sends it through `updating`, so every change
      // waits for the last to finish. Secrets can't be observed: each is compared with what was
      // last deployed, and sent when there's no telling, on an adoption.
      const repairing = live.status === "failed";
      let applied = false;
      const apply = <A, E, R>(change: Effect.Effect<A, E, R>) =>
        change.pipe(
          Effect.andThen(settleInstance(scope, liveId)),
          Effect.map((settled) => {
            live = settled;
            applied = true;
          }),
        );

      const delta = {
        ...(live.displayName === displayName ? {} : { displayName }),
        ...(news.description === undefined || (live.description ?? "") === news.description
          ? {}
          : { description: news.description }),
        ...(news.version === undefined || live.version === news.version
          ? {}
          : { version: news.version }),
        ...(news.enableAirflowExampleDags === undefined ||
        (live.enableAirflowExampleDags ?? false) === news.enableAirflowExampleDags
          ? {}
          : { enableAirflowExampleDags: news.enableAirflowExampleDags }),
        ...(news.enableStackitExampleDags === undefined ||
        (live.enableStackitExampleDags ?? false) === news.enableStackitExampleDags
          ? {}
          : { enableStackitExampleDags: news.enableStackitExampleDags }),
      };
      if (Object.keys(delta).length > 0) {
        yield* apply(
          workflows
            .updateInstance({ ...requestScope(scope), instanceId: liveId, ...delta })
            .pipe(Effect.retry(conflictRetry)),
        );
      }

      const identityProvider = news.identityProvider;
      if (identityProvider !== undefined) {
        const clientSecret =
          identityProvider.type === "oauth2" ? identityProvider.clientSecret : undefined;
        const previousSecret =
          olds?.identityProvider?.type === "oauth2"
            ? olds.identityProvider.clientSecret
            : undefined;
        const secretChanged =
          !created &&
          clientSecret !== undefined &&
          (olds === undefined || secretsDiffer(clientSecret, previousSecret));
        if (
          secretChanged ||
          observedIdentityProviderKey(live.identityProvider) !==
            desiredIdentityProviderKey(identityProvider)
        ) {
          yield* apply(
            workflows
              .updateIdentityProvider({
                ...requestScope(scope),
                instanceId: liveId,
                body: toIdentityProviderUpdate(identityProvider),
              })
              .pipe(Effect.retry(conflictRetry)),
          );
        }
      }

      if (news.observabilityId !== undefined && live.observabilityId !== news.observabilityId) {
        yield* apply(
          workflows
            .updateObservability({
              ...requestScope(scope),
              instanceId: liveId,
              observabilityId: news.observabilityId,
            })
            .pipe(Effect.retry(conflictRetry)),
        );
      }

      if (news.dagBundles !== undefined) {
        const { dagBundles: observedBundles } = yield* workflows.listDagBundles({
          ...requestScope(scope),
          instanceId: liveId,
        });
        const observedByName = new Map(observedBundles.map((bundle) => [bundle.name, bundle]));
        const desiredNames = new Set(news.dagBundles.map((bundle) => bundle.name));
        const previousBundles = new Map((olds?.dagBundles ?? []).map((b) => [b.name, b]));
        const bundleRequest = { ...requestScope(scope), instanceId: liveId };

        const toCreate = news.dagBundles.filter((bundle) => !observedByName.has(bundle.name));
        const toRetype = news.dagBundles.filter((bundle) => {
          const found = observedByName.get(bundle.name);
          return found !== undefined && found.type !== bundle.type;
        });
        // Refused before anything changes: every other bundle has to outlast the delete below.
        if (toRetype.length > 0 && observedBundles.length + toCreate.length < 2) {
          return yield* new DagBundleTypeChange({
            bundleName: toRetype[0]!.name,
            message: `DAG bundle ${toRetype[0]!.name} can't change type: the API can't change a bundle's type, and an instance keeps at least one bundle. Give the new bundle another name, or add a second one in the same deploy.`,
          });
        }

        // Creates go first and deletes last, because the API refuses to delete the last bundle.
        for (const bundle of toCreate) {
          yield* apply(
            workflows
              .createDagBundle({ ...bundleRequest, body: toBundleInput(bundle, scope.region) })
              .pipe(
                // Lost a race for the name: this deploy's values still go out.
                Effect.catchTag("Conflict", () =>
                  workflows.updateDagBundle({
                    ...bundleRequest,
                    bundleName: bundle.name,
                    body: toBundleUpdate(bundle, scope.region),
                  }),
                ),
              ),
          );
        }
        for (const bundle of news.dagBundles) {
          const found = observedByName.get(bundle.name);
          if (found === undefined || found.type !== bundle.type) continue;
          const previous = previousBundles.get(bundle.name);
          const secretChanged =
            !created &&
            bundleSecretOf(bundle) !== undefined &&
            (previous === undefined ||
              secretsDiffer(bundleSecretOf(bundle), bundleSecretOf(previous)));
          if (
            secretChanged ||
            observedBundleKey(found) !== desiredBundleKey(bundle, scope.region)
          ) {
            yield* apply(
              workflows
                .updateDagBundle({
                  ...bundleRequest,
                  bundleName: bundle.name,
                  body: toBundleUpdate(bundle, scope.region),
                })
                .pipe(Effect.retry(conflictRetry)),
            );
          }
        }
        for (const bundle of toRetype) {
          yield* apply(
            workflows
              .deleteDagBundle({ ...bundleRequest, bundleName: bundle.name })
              .pipe(Effect.catchTag("NotFound", () => Effect.void)),
          );
          yield* apply(
            workflows.createDagBundle({
              ...bundleRequest,
              body: toBundleInput(bundle, scope.region),
            }),
          );
        }
        // Only what the list reports and the props don't name, so a bundle made a moment ago by
        // someone else can't go here.
        for (const bundle of observedBundles) {
          if (desiredNames.has(bundle.name)) continue;
          yield* apply(
            workflows
              .deleteDagBundle({ ...bundleRequest, bundleName: bundle.name })
              .pipe(Effect.catchTag("NotFound", () => Effect.void)),
          );
        }
      }

      const repository = news.dagsRepository;
      if (repository !== undefined) {
        const secret = authSecretOf(repository.auth);
        const previous = olds?.dagsRepository;
        const secretChanged =
          !created &&
          secret !== undefined &&
          (previous === undefined || secretsDiffer(secret, authSecretOf(previous.auth)));
        if (
          secretChanged ||
          observedRepositoryKey(live.dagsRepository) !== desiredRepositoryKey(repository)
        ) {
          yield* apply(
            workflows
              .updateDagsRepository({
                ...requestScope(scope),
                instanceId: liveId,
                url: repository.url,
                branch: repository.branch,
                auth: repository.auth,
              })
              .pipe(Effect.retry(conflictRetry)),
          );
        }
      }

      // 4. Return — a `failed` from before the changes above isn't theirs, but with no change it
      // stands, and fails the deploy with the API's message.
      const final = yield* waitForInstance(scope, liveId, { staleFailure: repairing && applied });
      return toAttrs(scope, final);
    }),

    delete: Effect.fn(function* ({ output }) {
      const scope = { projectId: output.projectId, region: output.region };
      const found = yield* getInstanceOrUndefined(scope, output.instanceId);
      if (found === undefined) return;
      if (found.status === "deleting") return yield* waitForInstanceGone(scope, found.id);
      // A change in flight (an interrupted deploy) settles first.
      const settled = yield* settleInstance(scope, found.id).pipe(
        Effect.catchTag("NotFound", () => Effect.undefined),
      );
      if (settled === undefined) return;
      yield* workflows.deleteInstance({ ...requestScope(scope), instanceId: found.id }).pipe(
        Effect.retry(conflictRetry),
        Effect.catchTag("NotFound", () => Effect.void),
      );
      yield* waitForInstanceGone(scope, found.id, { staleFailure: settled.status === "failed" });
    }),
  });
