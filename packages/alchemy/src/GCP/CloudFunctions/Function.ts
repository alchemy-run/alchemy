import * as cloudfunctions from "@distilled.cloud/gcp/cloudfunctions_v2";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { deepEqual, isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { tagRecord } from "../../Tags.ts";
import { GcpEnvironment } from "../Environment.ts";
import {
  createInternalLabels,
  diffLabels,
  hasAlchemyLabels,
  stripInternalLabels,
  toLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";

const DEFAULT_LOCATION = "us-central1";
const DEFAULT_ENVIRONMENT = "GEN_2";
const DEFAULT_RUNTIME = "nodejs20";
const MAX_NAME_LENGTH = 63;

export type StorageSource = {
  /** GCS bucket that holds the source archive. */
  bucket?: string;
  /** Object name of the source archive (typically a `.zip`). */
  object?: string;
  /** Object generation. Omit to use the latest generation. */
  generation?: string;
  /** Signed upload URL returned by `generateUploadUrl` for 1st gen. */
  sourceUploadUrl?: string;
};

export type RepoSource = {
  /** Cloud Source Repository name. */
  repoName?: string;
  /** Branch regex (RE2). */
  branchName?: string;
  /** Tag regex (RE2). */
  tagName?: string;
  /** Commit SHA to build. */
  commitSha?: string;
  /** Directory relative to the repo root. */
  dir?: string;
  /** Project that owns the repository. Defaults to the function's project. */
  projectId?: string;
};

export type Source = {
  /** Source archive in Cloud Storage. */
  storageSource?: StorageSource;
  /** Source in Cloud Source Repositories. */
  repoSource?: RepoSource;
  /** GitHub URI. 1st gen only. */
  gitUri?: string;
};

export type BuildConfig = {
  /**
   * Runtime to build and run (e.g. `nodejs20`, `python312`). Required on
   * create.
   * @default "nodejs20"
   */
  runtime?: string;
  /**
   * Exported function in the source to execute. Defaults to the function
   * id.
   */
  entryPoint?: string;
  /** Location of the function source. Required on create. */
  source?: Source;
  /** Build-time environment variables. */
  environmentVariables?: Record<string, string>;
  /**
   * Cloud Build worker pool
   * (`projects/{project}/locations/{location}/workerPools/{workerPool}`).
   */
  workerPool?: string;
  /**
   * Artifact Registry Docker repository
   * (`projects/{project}/locations/{location}/repositories/{repository}`).
   */
  dockerRepository?: string;
  /**
   * Service account used for the build
   * (`projects/{project}/serviceAccounts/{email}`).
   */
  serviceAccount?: string;
};

export type SecretEnvVar = {
  /** Secret id (not the full resource name). */
  secret?: string;
  /** Environment variable name. */
  key?: string;
  /** Project that owns the secret. Defaults to the function's project. */
  projectId?: string;
  /** Secret version (`latest` or a number). */
  version?: string;
};

export type SecretVolume = {
  /** Secret id (not the full resource name). */
  secret?: string;
  /** Mount path inside the container (e.g. `/etc/secrets`). */
  mountPath?: string;
  /** Project that owns the secret. Defaults to the function's project. */
  projectId?: string;
  /** Versions to mount. Defaults to `latest` as a file named after the secret. */
  versions?: Array<{ path?: string; version?: string }>;
};

export type DirectVpcNetworkInterface = {
  /** VPC network name or URL. */
  network?: string;
  /** Subnetwork name or URL. */
  subnetwork?: string;
  /** Network tags applied to the function. */
  tags?: string[];
};

export type ServiceConfig = {
  /**
   * Memory available to each instance (e.g. `"256Mi"`, `"512M"`).
   * @default "256M"
   */
  availableMemory?: string;
  /** vCPU per instance (e.g. `"1"`). Derived from memory when omitted. */
  availableCpu?: string;
  /**
   * Request timeout in seconds.
   * @default 60
   */
  timeoutSeconds?: number;
  /** Minimum idle instances. */
  minInstanceCount?: number;
  /** Maximum concurrent instances. */
  maxInstanceCount?: number;
  /**
   * Max concurrent requests per instance.
   * @default 1
   */
  maxInstanceRequestConcurrency?: number;
  /** Runtime environment variables. */
  environmentVariables?: Record<string, string>;
  /**
   * Ingress (`ALLOW_ALL`, `ALLOW_INTERNAL_ONLY`,
   * `ALLOW_INTERNAL_AND_GCLB`).
   */
  ingressSettings?:
    | cloudfunctions.ServiceConfigIngressSettingsEnum
    | (string & {});
  /**
   * Serverless VPC Access connector
   * (`projects/{project}/locations/{location}/connectors/{connector}`).
   */
  vpcConnector?: string;
  /** Traffic sent through the VPC connector. */
  vpcConnectorEgressSettings?:
    | cloudfunctions.ServiceConfigVpcConnectorEgressSettingsEnum
    | (string & {});
  /** Runtime service account email. */
  serviceAccountEmail?: string;
  /**
   * Route 100% of traffic to the latest revision.
   * @default true
   */
  allTrafficOnLatestRevision?: boolean;
  /** Secret Manager values exposed as environment variables. */
  secretEnvironmentVariables?: SecretEnvVar[];
  /** Secret Manager values mounted as files. */
  secretVolumes?: SecretVolume[];
  /** Direct VPC egress setting. */
  directVpcEgress?:
    | cloudfunctions.ServiceConfigDirectVpcEgressEnum
    | (string & {});
  /** Direct VPC network interfaces. Mutually exclusive with `vpcConnector`. */
  directVpcNetworkInterface?: DirectVpcNetworkInterface[];
};

export type EventFilter = {
  /** CloudEvents attribute name. */
  attribute?: string;
  /** Value to match. */
  value?: string;
  /** Match operator. Only `match-path-pattern` is allowed. */
  operator?: string;
};

export type EventTrigger = {
  /**
   * Event type (e.g. `google.cloud.pubsub.topic.v1.messagePublished`).
   */
  eventType?: string;
  /**
   * Pub/Sub topic used as the transport
   * (`projects/{project}/topics/{topic}`).
   */
  pubsubTopic?: string;
  /** Service account email used to invoke the function. */
  serviceAccountEmail?: string;
  /** Retry failed deliveries. */
  retryPolicy?: cloudfunctions.EventTriggerRetryPolicyEnum | (string & {});
  /** CloudEvents attribute filters. */
  eventFilters?: EventFilter[];
  /**
   * Region that receives events. Defaults to the function location.
   */
  triggerRegion?: string;
  /**
   * Eventarc channel
   * (`projects/{project}/locations/{location}/channels/{channel}`) for partner events.
   */
  channel?: string;
  /** 1st gen hostname of the event service (e.g. `storage.googleapis.com`). */
  service?: string;
};

export type FunctionProps = {
  /**
   * Function id (the `{function}` segment of
   * `projects/{project}/locations/{location}/functions/{function}`).
   * If omitted, a unique name is generated from the stack, stage, and
   * logical id. 4-63 characters, matching `[a-z][a-z0-9-]*`. Immutable — changing
   * it replaces the function.
   */
  functionId?: string;
  /**
   * Region (`us-central1`, `europe-west1`, …). Immutable — changing it
   * replaces the function. `US-CENTRAL1` is accepted and normalized to
   * `us-central1`.
   * @default "us-central1"
   */
  location?: string;
  /**
   * Generation (`GEN_1` or `GEN_2`). Immutable — changing it replaces the
   * function.
   * @default "GEN_2"
   */
  environment?:
    | cloudfunctions.Cloudfunctions_FunctionEnvironmentEnum
    | (string & {});
  /** User-provided description. */
  description?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
  /**
   * Cloud KMS key used to encrypt function resources
   * (`projects/{project}/locations/{location}/keyRings/{keyRing}/cryptoKeys/{cryptoKey}`).
   */
  kmsKeyName?: string;
  /** Build step that turns source into a container. */
  buildConfig?: BuildConfig;
  /** Cloud Run service settings for the deployed function. */
  serviceConfig?: ServiceConfig;
  /** Eventarc trigger. Omit for an HTTPS function. */
  eventTrigger?: EventTrigger;
};

export type Function = Resource<
  "GCP.CloudFunctions.Function",
  FunctionProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/functions/{function}`. */
    name: string;
    /** Function id (last path segment). */
    functionId: string;
    /** Project id. */
    project: string;
    /** Location id (`us-central1`, …). */
    location: string;
    /** Generation (`GEN_1` or `GEN_2`). */
    environment: string;
    /** User-provided description. */
    description: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** HTTPS URL of the function. */
    url: string | undefined;
    /** Server-reported state (`ACTIVE`, `DEPLOYING`, `FAILED`, …). */
    state: string | undefined;
    /** KMS key used for encryption, if any. */
    kmsKeyName: string | undefined;
    /** Runtime (e.g. `nodejs20`). */
    runtime: string | undefined;
    /** Source entry point. */
    entryPoint: string | undefined;
    /** Cloud Run service resource name. */
    service: string | undefined;
    /** Cloud Run service URI. */
    uri: string | undefined;
    /** Memory limit. */
    availableMemory: string | undefined;
    /** Request timeout in seconds. */
    timeoutSeconds: number | undefined;
    /** Minimum instance count. */
    minInstanceCount: number | undefined;
    /** Maximum instance count. */
    maxInstanceCount: number | undefined;
    /** Runtime service account email. */
    serviceAccountEmail: string | undefined;
    /** Eventarc trigger resource name, if any. */
    trigger: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Google Cloud Function (2nd gen) that builds source into a Cloud Run
 * service.
 *
 * Changing `functionId`, `location`, or `environment` replaces the function.
 * Source, runtime, service settings, labels, and event triggers update
 * in place.
 *
 * ### Creating a Function
 * **Example:** Generated name
 * ```typescript
 * const hello = yield* GCP.CloudFunctions.Function("Hello", {
 *   buildConfig: {
 *     runtime: "nodejs20",
 *     entryPoint: "helloHttp",
 *     source: {
 *       storageSource: {
 *         bucket: "my-source",
 *         object: "hello.zip",
 *       },
 *     },
 *   },
 * });
 * ```
 *
 * **Example:** Explicit id, labels, and memory
 * ```typescript
 * const hello = yield* GCP.CloudFunctions.Function("Hello", {
 *   functionId: "order-http",
 *   location: "us-central1",
 *   description: "HTTP handler",
 *   labels: { env: "prod" },
 *   buildConfig: {
 *     runtime: "nodejs20",
 *     entryPoint: "helloHttp",
 *     source: {
 *       storageSource: { bucket: "my-source", object: "hello.zip" },
 *     },
 *   },
 *   serviceConfig: {
 *     availableMemory: "256Mi",
 *     timeoutSeconds: 60,
 *     maxInstanceCount: 10,
 *   },
 * });
 * ```
 *
 * ### Event Triggers
 * **Example:** Pub/Sub trigger
 * ```typescript
 * const consumer = yield* GCP.CloudFunctions.Function("Consume", {
 *   buildConfig: {
 *     runtime: "nodejs20",
 *     entryPoint: "onMessage",
 *     source: {
 *       storageSource: { bucket: "my-source", object: "consumer.zip" },
 *     },
 *   },
 *   eventTrigger: {
 *     eventType: "google.cloud.pubsub.topic.v1.messagePublished",
 *     pubsubTopic: topic.name,
 *   },
 * });
 * ```
 *
 * ### Reading a Function
 * **Example:** Get the live function
 * ```typescript
 * const getFunction = yield* GCP.CloudFunctions.GetFunction(hello);
 * const live = yield* getFunction();
 * ```
 *
 * ### Downloading Source
 * **Example:** Signed download URL
 * ```typescript
 * const download = yield* GCP.CloudFunctions.GenerateDownloadUrl(hello);
 * const { downloadUrl } = yield* download();
 * ```
 *
 * @resource
 * @product GCP
 * @category CloudFunctions
 */
export const Function = Resource<Function>("GCP.CloudFunctions.Function");

export class FunctionNotResolved extends Data.TaggedError(
  "GCP.CloudFunctions.FunctionNotResolved",
)<{
  name: string;
}> {}

export class FunctionOperationFailed extends Data.TaggedError(
  "GCP.CloudFunctions.FunctionOperationFailed",
)<{
  operation: string;
  message: string;
}> {}

export class FunctionOperationPending extends Data.TaggedError(
  "GCP.CloudFunctions.FunctionOperationPending",
)<{
  operation: string;
}> {}

export class FunctionStillExists extends Data.TaggedError(
  "GCP.CloudFunctions.FunctionStillExists",
)<{
  name: string;
}> {}

export class FunctionDeployFailed extends Data.TaggedError(
  "GCP.CloudFunctions.FunctionDeployFailed",
)<{
  name: string;
  state: string;
  message: string;
}> {}

const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

const normalizeLocation = (location: string | undefined) =>
  lastSegment(location ?? DEFAULT_LOCATION).toLowerCase();

const normalizeEnvironment = (environment: string | undefined) => {
  const value = (environment ?? DEFAULT_ENVIRONMENT).toUpperCase();
  return value === "ENVIRONMENT_UNSPECIFIED" ? DEFAULT_ENVIRONMENT : value;
};

const resourceName = (project: string, location: string, functionId: string) =>
  `projects/${project}/locations/${location}/functions/${functionId}`;

const parseName = (name: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const functionsAt = parts.lastIndexOf("functions");
  const locationsAt = parts.lastIndexOf("locations");
  const projectsAt = parts.lastIndexOf("projects");
  return {
    project:
      projectsAt >= 0 && parts[projectsAt + 1] ? parts[projectsAt + 1]! : "",
    location:
      locationsAt >= 0 && parts[locationsAt + 1]
        ? parts[locationsAt + 1]!
        : DEFAULT_LOCATION,
    functionId:
      functionsAt >= 0 && parts[functionsAt + 1]
        ? parts[functionsAt + 1]!
        : lastSegment(name),
  };
};

const userLabels = (
  labels: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalLabels(tagRecord(labels));

const toId = (id: string, functionId: string | undefined, existing?: string) =>
  Effect.gen(function* () {
    return (
      functionId ??
      existing ??
      (yield* createPhysicalName({
        id,
        maxLength: MAX_NAME_LENGTH,
        lowercase: true,
      }))
    );
  });

const stable = (value: unknown) => JSON.stringify(value ?? null);

const envMap = (value: Record<string, string | undefined> | null | undefined) =>
  tagRecord(value);

const normalizeGeneration = (generation: string | undefined) =>
  generation === undefined || generation === "0" ? "" : generation;

const sanitizeSource = (source: Source | undefined): Source | undefined => {
  if (source === undefined) return undefined;
  const storage = source.storageSource;
  if (storage === undefined) return source;
  const generation = normalizeGeneration(storage.generation);
  return {
    ...source,
    storageSource: {
      bucket: storage.bucket,
      object: storage.object,
      sourceUploadUrl: storage.sourceUploadUrl,
      generation: generation === "" ? undefined : generation,
    },
  };
};

const sameSource = (desired?: Source, observed?: Source) => {
  const desiredStorage = desired?.storageSource;
  const observedStorage = observed?.storageSource;
  const desiredRepo = desired?.repoSource;
  const observedRepo = observed?.repoSource;
  const desiredGeneration = normalizeGeneration(desiredStorage?.generation);
  const observedGeneration = normalizeGeneration(observedStorage?.generation);
  const generationEqual =
    desiredGeneration === "" || desiredGeneration === observedGeneration;
  return (
    (desired?.gitUri ?? "") === (observed?.gitUri ?? "") &&
    (desiredStorage?.bucket ?? "") === (observedStorage?.bucket ?? "") &&
    (desiredStorage?.object ?? "") === (observedStorage?.object ?? "") &&
    (desiredStorage?.sourceUploadUrl ?? "") ===
      (observedStorage?.sourceUploadUrl ?? "") &&
    generationEqual &&
    (desiredRepo?.repoName ?? "") === (observedRepo?.repoName ?? "") &&
    (desiredRepo?.branchName ?? "") === (observedRepo?.branchName ?? "") &&
    (desiredRepo?.tagName ?? "") === (observedRepo?.tagName ?? "") &&
    (desiredRepo?.commitSha ?? "") === (observedRepo?.commitSha ?? "") &&
    (desiredRepo?.dir ?? "") === (observedRepo?.dir ?? "") &&
    (desiredRepo?.projectId ?? "") === (observedRepo?.projectId ?? "")
  );
};

const toAttrs = (
  fn: cloudfunctions.Cloudfunctions_Function,
  project: string,
) => {
  const name = fn.name ?? "";
  const parsed = parseName(name);
  return {
    name,
    functionId: parsed.functionId,
    project: parsed.project || project,
    location: parsed.location,
    environment: normalizeEnvironment(fn.environment),
    description: fn.description,
    labels: userLabels(fn.labels),
    url: fn.url,
    state: fn.state,
    kmsKeyName: fn.kmsKeyName,
    runtime: fn.buildConfig?.runtime,
    entryPoint: fn.buildConfig?.entryPoint,
    service: fn.serviceConfig?.service,
    uri: fn.serviceConfig?.uri,
    availableMemory: fn.serviceConfig?.availableMemory,
    timeoutSeconds: fn.serviceConfig?.timeoutSeconds,
    minInstanceCount: fn.serviceConfig?.minInstanceCount,
    maxInstanceCount: fn.serviceConfig?.maxInstanceCount,
    serviceAccountEmail: fn.serviceConfig?.serviceAccountEmail,
    trigger: fn.eventTrigger?.trigger,
    createTime: fn.createTime,
    updateTime: fn.updateTime,
  };
};

const getByName = (name: string) =>
  cloudfunctions
    .getProjectsLocationsFunctions({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const isAlreadyExists = (error: cloudfunctions.Status | undefined) =>
  error?.code === 6 ||
  (error?.message ?? "").includes("ALREADY_EXISTS") ||
  (error?.message ?? "").toLowerCase().includes("already exists");

const isNotFoundStatus = (error: cloudfunctions.Status | undefined) => {
  if (error === undefined) return false;
  if (error.code === 5) return true;
  return (error.message ?? "").toLowerCase().includes("not found");
};

const failedMessage = (fn: cloudfunctions.Cloudfunctions_Function) =>
  fn.stateMessages
    ?.map((item) => item.message)
    .filter((item): item is string => typeof item === "string")
    .join("; ") || "function is in FAILED state";

const waitForOperation = (
  operation: cloudfunctions.Operation,
  options?: { notFoundOk?: boolean; alreadyExistsOk?: boolean },
) =>
  Effect.gen(function* () {
    const name = operation.name;
    if (operation.done === true) {
      if (operation.error) {
        if (
          options?.alreadyExistsOk === true &&
          isAlreadyExists(operation.error)
        ) {
          return operation;
        }
        if (options?.notFoundOk === true && isNotFoundStatus(operation.error)) {
          return operation;
        }
        return yield* new FunctionOperationFailed({
          operation: name ?? "",
          message: operation.error.message ?? "operation failed",
        });
      }
      return operation;
    }
    if (name === undefined || name.length === 0) {
      return yield* new FunctionOperationFailed({
        operation: "",
        message: "operation is missing a name",
      });
    }

    const getOperation = cloudfunctions.getProjectsLocationsOperations({
      name,
    });
    const resolved =
      options?.notFoundOk === true
        ? getOperation.pipe(
            Effect.catchTag("NotFound", () =>
              Effect.succeed({
                name,
                done: true,
              } satisfies cloudfunctions.Operation),
            ),
          )
        : getOperation.pipe(
            Effect.retry({
              while: (error) => error._tag === "NotFound",
              times: 5,
              schedule: Schedule.exponential("250 millis"),
            }),
          );

    return yield* resolved.pipe(
      Effect.filterOrFail(
        (current) => current.done === true,
        () => new FunctionOperationPending({ operation: name }),
      ),
      Effect.flatMap((current) => {
        const error = current.error;
        const ignore =
          (options?.alreadyExistsOk === true && isAlreadyExists(error)) ||
          (options?.notFoundOk === true && isNotFoundStatus(error));
        return error && !ignore
          ? Effect.fail(
              new FunctionOperationFailed({
                operation: name,
                message: error.message ?? "operation failed",
              }),
            )
          : Effect.succeed(current);
      }),
      Effect.retry({
        while: (error) =>
          error._tag === "GCP.CloudFunctions.FunctionOperationPending",
        times: 10,
        schedule: Schedule.spaced("8 seconds"),
      }),
    );
  });

const waitUntilReady = (name: string) =>
  getByName(name).pipe(
    Effect.filterOrFail(
      (fn): fn is cloudfunctions.Cloudfunctions_Function => fn !== undefined,
      () => new FunctionNotResolved({ name }),
    ),
    Effect.filterOrFail(
      (fn) => fn.state !== "FAILED",
      (fn) =>
        new FunctionDeployFailed({
          name,
          state: fn.state ?? "FAILED",
          message: failedMessage(fn),
        }),
    ),
    Effect.filterOrFail(
      (fn) => fn.state === "ACTIVE" || fn.state === undefined,
      () => new FunctionNotResolved({ name }),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.CloudFunctions.FunctionNotResolved",
      times: 8,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

const waitUntilGone = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((fn) =>
      fn === undefined
        ? Effect.void
        : Effect.fail(new FunctionStillExists({ name })),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.CloudFunctions.FunctionStillExists",
      times: 10,
      schedule: Schedule.spaced("3 seconds"),
    }),
  );

const mergeBuildConfig = (
  news: BuildConfig | undefined,
  observed: cloudfunctions.BuildConfig | undefined,
): cloudfunctions.BuildConfig => ({
  runtime: news?.runtime ?? observed?.runtime ?? DEFAULT_RUNTIME,
  entryPoint: news?.entryPoint ?? observed?.entryPoint,
  source: sanitizeSource(news?.source) ?? observed?.source,
  environmentVariables:
    news?.environmentVariables ?? envMap(observed?.environmentVariables),
  workerPool: news?.workerPool ?? observed?.workerPool,
  dockerRepository: news?.dockerRepository ?? observed?.dockerRepository,
  serviceAccount: news?.serviceAccount ?? observed?.serviceAccount,
});

const sameBuildConfig = (
  desired: cloudfunctions.BuildConfig,
  observed: cloudfunctions.BuildConfig | undefined,
) =>
  (desired.runtime ?? "") === (observed?.runtime ?? "") &&
  (desired.entryPoint ?? "") === (observed?.entryPoint ?? "") &&
  (desired.workerPool ?? "") === (observed?.workerPool ?? "") &&
  (desired.dockerRepository ?? "") === (observed?.dockerRepository ?? "") &&
  (desired.serviceAccount ?? "") === (observed?.serviceAccount ?? "") &&
  deepEqual(
    envMap(desired.environmentVariables),
    envMap(observed?.environmentVariables),
    { stripNullish: true },
  ) &&
  sameSource(desired.source, observed?.source);

const eventTriggerKey = (trigger: EventTrigger | undefined) => {
  if (trigger === undefined) return "";
  const filters = [...(trigger.eventFilters ?? [])]
    .map((filter) => ({
      attribute: filter.attribute ?? "",
      value: filter.value ?? "",
      operator: filter.operator ?? "",
    }))
    .sort((a, b) => a.attribute.localeCompare(b.attribute));
  return stable({
    eventType: trigger.eventType ?? "",
    pubsubTopic: trigger.pubsubTopic ?? "",
    serviceAccountEmail: trigger.serviceAccountEmail ?? "",
    retryPolicy: trigger.retryPolicy ?? "",
    triggerRegion: trigger.triggerRegion ?? "",
    channel: trigger.channel ?? "",
    service: trigger.service ?? "",
    filters,
  });
};

const observedEventTrigger = (
  trigger: cloudfunctions.EventTrigger | undefined,
): EventTrigger | undefined => {
  if (trigger === undefined) return undefined;
  return {
    eventType: trigger.eventType,
    pubsubTopic: trigger.pubsubTopic,
    serviceAccountEmail: trigger.serviceAccountEmail,
    retryPolicy: trigger.retryPolicy,
    eventFilters: trigger.eventFilters,
    triggerRegion: trigger.triggerRegion,
    channel: trigger.channel,
    service: trigger.service,
  };
};

export const FunctionProvider = () =>
  Provider.succeed(Function, {
    stables: [
      "name",
      "functionId",
      "project",
      "location",
      "environment",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;

      const previousId = olds?.functionId ?? output?.functionId;
      const nextId = news.functionId ?? previousId;
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
      );
      const nextLocation = normalizeLocation(news.location ?? output?.location);
      const previousEnvironment = normalizeEnvironment(
        olds?.environment ?? output?.environment,
      );
      const nextEnvironment = normalizeEnvironment(
        news.environment ?? output?.environment,
      );

      const replace =
        (previousId !== undefined &&
          news.functionId !== undefined &&
          news.functionId !== previousId) ||
        previousLocation !== nextLocation ||
        previousEnvironment !== nextEnvironment;

      if (!replace) return undefined;
      return {
        action: "replace" as const,
        deleteFirst: previousId !== undefined && nextId === previousId,
      };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const functionId = yield* toId(id, olds?.functionId, output?.functionId);
      const location = normalizeLocation(olds?.location ?? output?.location);
      const name =
        output?.name ?? resourceName(env.project, location, functionId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        return yield* cloudfunctions.listProjectsLocationsFunctions
          .pages({
            parent: `projects/${env.project}/locations/-`,
            pageSize: 1000,
          })
          .pipe(
            Stream.flatMap((page) => Stream.fromIterable(page.functions ?? [])),
            Stream.filter((fn) =>
              Object.keys(fn.labels ?? {}).some((key) =>
                key.startsWith("alchemy-"),
              ),
            ),
            Stream.map((fn) => toAttrs(fn, env.project)),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
          );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const functionId = yield* toId(id, news.functionId, output?.functionId);
      const location = normalizeLocation(news.location ?? output?.location);
      const environment = normalizeEnvironment(
        news.environment ?? output?.environment,
      );
      const name = resourceName(env.project, location, functionId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };

      let current = yield* getByName(name);
      if (current?.state === "DELETING") {
        yield* waitUntilGone(name);
        current = undefined;
      }

      if (current === undefined) {
        const created = yield* cloudfunctions
          .createProjectsLocationsFunctions({
            parent: `projects/${env.project}/locations/${location}`,
            functionId,
            body: {
              name,
              description: news.description,
              labels: desiredLabels,
              kmsKeyName: news.kmsKeyName,
              environment,
              buildConfig: mergeBuildConfig(news.buildConfig, undefined),
              serviceConfig: news.serviceConfig,
              eventTrigger: news.eventTrigger,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          yield* waitForOperation(created, { alreadyExistsOk: true });
        }
        current = yield* waitUntilReady(name);
      }
      if (current === undefined) {
        return yield* new FunctionNotResolved({ name });
      }

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const descriptionChanged =
        (current.description ?? "") !== (news.description ?? "");
      const kmsChanged =
        news.kmsKeyName !== undefined &&
        (current.kmsKeyName ?? "") !== news.kmsKeyName;

      const desiredBuild =
        news.buildConfig !== undefined
          ? mergeBuildConfig(news.buildConfig, current.buildConfig)
          : undefined;
      const buildConfigChanged =
        desiredBuild !== undefined &&
        !sameBuildConfig(desiredBuild, current.buildConfig);

      const desiredService = news.serviceConfig;
      const serviceConfigChanged =
        desiredService !== undefined &&
        ((desiredService.availableMemory !== undefined &&
          (current.serviceConfig?.availableMemory ?? "") !==
            desiredService.availableMemory) ||
          (desiredService.availableCpu !== undefined &&
            (current.serviceConfig?.availableCpu ?? "") !==
              desiredService.availableCpu) ||
          (desiredService.timeoutSeconds !== undefined &&
            (current.serviceConfig?.timeoutSeconds ?? 60) !==
              desiredService.timeoutSeconds) ||
          (desiredService.minInstanceCount !== undefined &&
            (current.serviceConfig?.minInstanceCount ?? 0) !==
              desiredService.minInstanceCount) ||
          (desiredService.maxInstanceCount !== undefined &&
            (current.serviceConfig?.maxInstanceCount ?? 0) !==
              desiredService.maxInstanceCount) ||
          (desiredService.maxInstanceRequestConcurrency !== undefined &&
            (current.serviceConfig?.maxInstanceRequestConcurrency ?? 1) !==
              desiredService.maxInstanceRequestConcurrency) ||
          (desiredService.environmentVariables !== undefined &&
            !deepEqual(
              envMap(desiredService.environmentVariables),
              envMap(current.serviceConfig?.environmentVariables),
              { stripNullish: true },
            )) ||
          (desiredService.ingressSettings !== undefined &&
            (current.serviceConfig?.ingressSettings ?? "") !==
              desiredService.ingressSettings) ||
          (desiredService.vpcConnector !== undefined &&
            (current.serviceConfig?.vpcConnector ?? "") !==
              desiredService.vpcConnector) ||
          (desiredService.vpcConnectorEgressSettings !== undefined &&
            (current.serviceConfig?.vpcConnectorEgressSettings ?? "") !==
              desiredService.vpcConnectorEgressSettings) ||
          (desiredService.serviceAccountEmail !== undefined &&
            (current.serviceConfig?.serviceAccountEmail ?? "") !==
              desiredService.serviceAccountEmail) ||
          (desiredService.allTrafficOnLatestRevision !== undefined &&
            (current.serviceConfig?.allTrafficOnLatestRevision ?? true) !==
              desiredService.allTrafficOnLatestRevision) ||
          (desiredService.secretEnvironmentVariables !== undefined &&
            stable(desiredService.secretEnvironmentVariables) !==
              stable(current.serviceConfig?.secretEnvironmentVariables)) ||
          (desiredService.secretVolumes !== undefined &&
            stable(desiredService.secretVolumes) !==
              stable(current.serviceConfig?.secretVolumes)) ||
          (desiredService.directVpcEgress !== undefined &&
            (current.serviceConfig?.directVpcEgress ?? "") !==
              desiredService.directVpcEgress) ||
          (desiredService.directVpcNetworkInterface !== undefined &&
            stable(desiredService.directVpcNetworkInterface) !==
              stable(current.serviceConfig?.directVpcNetworkInterface)));

      const eventTriggerChanged =
        news.eventTrigger !== undefined &&
        eventTriggerKey(news.eventTrigger) !==
          eventTriggerKey(observedEventTrigger(current.eventTrigger));

      if (
        labelsChanged ||
        descriptionChanged ||
        kmsChanged ||
        buildConfigChanged ||
        serviceConfigChanged ||
        eventTriggerChanged
      ) {
        const updateMask = [
          labelsChanged ? "labels" : undefined,
          descriptionChanged ? "description" : undefined,
          kmsChanged ? "kmsKeyName" : undefined,
          buildConfigChanged ? "buildConfig" : undefined,
          serviceConfigChanged ? "serviceConfig" : undefined,
          eventTriggerChanged ? "eventTrigger" : undefined,
        ].filter((field): field is string => field !== undefined);

        const operation = yield* cloudfunctions.patchProjectsLocationsFunctions(
          {
            name,
            updateMask: updateMask.join(","),
            body: {
              name,
              labels: desiredLabels,
              description: news.description,
              kmsKeyName: news.kmsKeyName ?? current.kmsKeyName,
              buildConfig: desiredBuild ?? current.buildConfig,
              serviceConfig: {
                ...current.serviceConfig,
                ...desiredService,
                service: undefined,
                uri: undefined,
                revision: undefined,
              },
              eventTrigger: news.eventTrigger ?? current.eventTrigger,
            },
          },
        );
        yield* waitForOperation(operation);
        current = yield* waitUntilReady(name);
      }
      if (current === undefined) {
        return yield* new FunctionNotResolved({ name });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* cloudfunctions
        .deleteProjectsLocationsFunctions({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
      if (operation !== undefined) {
        yield* waitForOperation(operation, { notFoundOk: true });
      }
      yield* waitUntilGone(output.name);
    }),
  });
