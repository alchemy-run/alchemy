import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as cloudrun from "@distilled.cloud/gcp/run_v2";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import type * as Bundle from "../../Bundle/Bundle.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import { Platform, type Main, type PlatformProps } from "../../Platform.ts";
import * as Provider from "../../Provider.ts";
import { Resource, type ResourceBinding } from "../../Resource.ts";
import {
  createHostRuntimeContext,
  type HostRuntimeContext,
  type ServerHost,
} from "../../Server/Process.ts";
import { tagRecord } from "../../Tags.ts";
import { makeImageSource } from "../ArtifactRegistry/ImageSource.ts";
import { GcpEnvironment } from "../Environment.ts";
import {
  applyHostBindings,
  defaultComputeServiceAccount,
  type GcpHostBinding,
} from "../Host.ts";
import {
  createInternalLabels,
  diffLabels,
  hasAlchemyLabels,
  stripInternalLabels,
  toLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";

const DEFAULT_LOCATION = "us-central1";
const DEFAULT_IMAGE = "us-docker.pkg.dev/cloudrun/container/hello";
const MAX_NAME_LENGTH = 49;

export type EnvVar = {
  /** Environment variable name. */
  name?: string;
  /** Literal value. Mutually exclusive with `valueSource`. */
  value?: string;
  /** Secret Manager source for the value. */
  valueSource?: {
    secretKeyRef?: {
      secret?: string;
      version?: string;
    };
  };
};

export type ContainerPort = {
  /** Protocol name (`http1` or `h2c`). */
  name?: string;
  /** TCP port the container listens on. */
  containerPort?: number;
};

export type ResourceRequirements = {
  /** Resource limits. Keys: `cpu`, `memory`, `nvidia.com/gpu`. */
  limits?: Record<string, string>;
  /** Allocate CPU only during requests. */
  cpuIdle?: boolean;
  /** Boost CPU on startup to reduce cold starts. */
  startupCpuBoost?: boolean;
};

export type Container = {
  /** DNS_LABEL container name. */
  name?: string;
  /**
   * Container image (Artifact Registry, GCR, or Docker Hub). Required
   * unless `template` is omitted, in which case the public Cloud Run hello
   * image is used.
   */
  image?: string;
  /** Entrypoint. */
  command?: string[];
  /** Arguments to the entrypoint. */
  args?: string[];
  /** Environment variables. */
  env?: EnvVar[];
  /** Exposed ports. Only one port may be set. */
  ports?: ContainerPort[];
  /** CPU / memory / GPU requirements. */
  resources?: ResourceRequirements;
  /** Working directory. */
  workingDir?: string;
};

export type RevisionScaling = {
  /** Minimum serving instances. */
  minInstanceCount?: number;
  /** Maximum serving instances. Server default is 100. */
  maxInstanceCount?: number;
  /** CPU utilization target in `[0.1, 0.95]`, or `0` to disable. */
  cpuUtilization?: number;
  /** Concurrency utilization target in `[0.1, 0.95]`, or `0` to disable. */
  concurrencyUtilization?: number;
};

export type RevisionTemplate = {
  /** Containers that make up the revision. */
  containers?: Container[];
  /** Request timeout (e.g. `"300s"`). */
  timeout?: string;
  /** Max concurrent requests per instance. `0` uses the server default. */
  maxInstanceRequestConcurrency?: number;
  /** Runtime service account email. Defaults to the project Compute SA. */
  serviceAccount?: string;
  /** Sandbox (`EXECUTION_ENVIRONMENT_GEN1` or `EXECUTION_ENVIRONMENT_GEN2`). */
  executionEnvironment?: string;
  /** Enable session affinity. */
  sessionAffinity?: boolean;
  /** Revision-level scaling. */
  scaling?: RevisionScaling;
  /** Revision labels. */
  labels?: Record<string, string>;
  /** Revision annotations. */
  annotations?: Record<string, string>;
  /** Direct VPC egress / connector. */
  vpcAccess?: cloudrun.GoogleCloudRunV2VpcAccess;
  /** Volumes available to containers. */
  volumes?: cloudrun.GoogleCloudRunV2VolumeList;
  /** CMEK used to encrypt the container image. */
  encryptionKey?: string;
  /** Unique revision name. Generated from the service name if omitted. */
  revision?: string;
};

export type TrafficTarget = {
  /** Allocation type (`TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST` or `_REVISION`). */
  type?: string;
  /** Revision to send traffic to when allocating by revision. */
  revision?: string;
  /** Percent of traffic (0–100). */
  percent?: number;
  /** URI tag for this target. */
  tag?: string;
};

export type ServiceScaling = {
  /** Minimum instances across all revisions. */
  minInstanceCount?: number;
  /** Maximum instances across all revisions. */
  maxInstanceCount?: number;
  /** `AUTOMATIC` or `MANUAL`. */
  scalingMode?: string;
  /** Instance count in manual scaling mode. */
  manualInstanceCount?: number;
};

export type ServiceProps = PlatformProps & {
  /**
   * Service id (the `{service}` segment of
   * `projects/{project}/locations/{location}/services/{service}`). If
   * omitted, a unique name is generated from the stack, stage, and logical
   * id. Must begin with a letter, not end with a hyphen, and be fewer than
   * 50 characters. Immutable — changing it replaces the service.
   */
  serviceId?: string;
  /**
   * Region (`us-central1`, `europe-west1`, …). Immutable — changing it
   * replaces the service. `US-CENTRAL1` is accepted and normalized to
   * `us-central1`.
   * @default "us-central1"
   */
  location?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
  /**
   * Unstructured annotations. Cloud Run rejects `run.googleapis.com` /
   * `cloud.googleapis.com` / Knative namespaces.
   */
  annotations?: Record<string, string>;
  /**
   * Human-readable description (max 512 characters).
   */
  description?: string;
  /**
   * Ingress (`INGRESS_TRAFFIC_ALL`, `INGRESS_TRAFFIC_INTERNAL_ONLY`,
   * `INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER`, `INGRESS_TRAFFIC_NONE`).
   */
  ingress?: cloudrun.GoogleCloudRunV2ServiceIngressEnum | (string & {});
  /**
   * Disable the IAM invoker check (`run.routes.invoke`).
   * @default false
   */
  invokerIamDisabled?: boolean;
  /**
   * Disable public resolution of the default `*.run.app` URI.
   * @default false
   */
  defaultUriDisabled?: boolean;
  /**
   * Enable Identity-Aware Proxy on the service.
   */
  iapEnabled?: boolean;
  /**
   * Custom audiences encoded into ID tokens.
   */
  customAudiences?: string[];
  /**
   * Service-level scaling.
   */
  scaling?: ServiceScaling;
  /**
   * Traffic split. Empty / omitted sends 100% to the latest Ready
   * revision.
   */
  traffic?: TrafficTarget[];
  /**
   * Revision template. If omitted, a single container runs the public
   * Cloud Run hello image. The Effect-native `main` form fills `image`
   * for you.
   */
  template?: RevisionTemplate;
  /**
   * Module entrypoint for an Effect-native service (typically
   * `import.meta.url`). Alchemy bundles the program, builds a container
   * image, pushes it to Artifact Registry, and deploys Cloud Run.
   * Bindings attach env + IAM onto the runtime service account.
   */
  main?: string;
  /**
   * Named export to load from `main`.
   * @default "default"
   */
  handler?: string;
  /**
   * HTTP port the Effect-native program listens on (Cloud Run injects
   * `PORT`). Only used with `main`.
   * @default 8080
   */
  port?: number;
  /**
   * Additional environment variables for the Effect-native container.
   * Merged after binding-injected `env`.
   */
  env?: Record<string, any>;
  /**
   * Bundler configuration for `main`.
   */
  build?: Bundle.BundleConfig;
};

export type Service = Resource<
  "GCP.Run.Service",
  ServiceProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/services/{service}`. */
    name: string;
    /** Service id (last path segment). */
    serviceId: string;
    /** Project id. */
    project: string;
    /** Region (`us-central1`, …). */
    location: string;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** User annotations. */
    annotations: Record<string, string>;
    /** Description. */
    description: string | undefined;
    /** Main serving URI. */
    uri: string | undefined;
    /** All serving URLs. */
    urls: ReadonlyArray<string>;
    /** Server-assigned UUID. */
    uid: string | undefined;
    /** Ingress setting. */
    ingress: string | undefined;
    /** Whether the IAM invoker check is disabled. */
    invokerIamDisabled: boolean;
    /** Latest created revision name. */
    latestCreatedRevision: string | undefined;
    /** Latest Ready revision name. */
    latestReadyRevision: string | undefined;
    /** Terminal condition state (`CONDITION_SUCCEEDED`, …). */
    terminalConditionState: string | undefined;
    /** True while Cloud Run is still reconciling the desired state. */
    reconciling: boolean;
    /** Observed generation. */
    generation: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  GcpHostBinding,
  Providers
>;

export type ServiceRuntimeContext = HostRuntimeContext;
export type ServiceServices = Credentials | GcpEnvironment | ServerHost;
export type ServiceShape = Main<ServiceServices>;

/**
 * A Cloud Run service (Knative serving revision + traffic).
 *
 * Changing `serviceId` or `location` replaces the service. Updates to
 * `template` create a new revision.
 *
 * This is GCP's effectful HTTP platform — the analog of
 * `AWS.Lambda.Function` / `Cloudflare.Worker`. Pass `main` plus an
 * Effect implementation; bindings grant IAM onto the runtime service
 * account and inject env, the way AWS `policyStatements` land on the
 * execution role.
 *
 * ### Creating a Service
 * **Example:** Generated name, default hello image
 * ```typescript
 * const api = yield* GCP.Run.Service("api", {});
 * ```
 *
 * **Example:** Explicit id, image, env, and labels
 * ```typescript
 * const api = yield* GCP.Run.Service("api", {
 *   serviceId: "order-api",
 *   location: "us-central1",
 *   description: "order HTTP API",
 *   labels: { env: "prod" },
 *   ingress: "INGRESS_TRAFFIC_ALL",
 *   template: {
 *     timeout: "60s",
 *     containers: [
 *       {
 *         image: "us-docker.pkg.dev/cloudrun/container/hello",
 *         env: [{ name: "ENV", value: "prod" }],
 *       },
 *     ],
 *   },
 * });
 * ```
 *
 * ### Effect-native Function with bindings
 * **Example:** Publish tweets to Pub/Sub, cache in Memorystore
 * ```typescript
 * const tweets = yield* GCP.PubSub.Topic("tweets", {});
 * const cache = yield* GCP.Redis.Instance("Cache", { memorySizeGb: 1 });
 *
 * export class TweetBot extends GCP.Run.Service<TweetBot>()(
 *   "TweetBot",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const publish = yield* GCP.PubSub.Publish(tweets);
 *     const redis = yield* GCP.Redis.ReadWriteRedis(cache);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const body = yield* redis.get("last-tweet");
 *         yield* publish({ json: { text: body ?? "hello twitter" } });
 *         return HttpServerResponse.text("queued");
 *       }),
 *     };
 *   }).pipe(
 *     Effect.provide(GCP.PubSub.PublishHttp),
 *     Effect.provide(GCP.Redis.ReadWriteRedisHttp),
 *   ),
 * ) {}
 * ```
 *
 * ### Reading a Service
 * **Example:** Get the live service
 * ```typescript
 * const getService = yield* GCP.Run.GetService(api);
 * const live = yield* getService();
 * ```
 *
 * @resource
 * @product GCP
 * @category Run
 */
export const Service: Platform<
  Service,
  ServiceServices,
  ServiceShape,
  ServiceRuntimeContext
> = Platform("GCP.Run.Service", {
  createRuntimeContext: createHostRuntimeContext("GCP.Run.Service") as (
    id: string,
  ) => ServiceRuntimeContext,
});

export class ServiceNotResolved extends Data.TaggedError(
  "GCP.Run.ServiceNotResolved",
)<{
  name: string;
}> {}

export class ServiceNotReady extends Data.TaggedError(
  "GCP.Run.ServiceNotReady",
)<{
  name: string;
  state: string;
  message: string;
}> {}

export class ServiceReconciling extends Data.TaggedError(
  "GCP.Run.ServiceReconciling",
)<{
  name: string;
  state: string;
}> {}

export class ServiceStillExists extends Data.TaggedError(
  "GCP.Run.ServiceStillExists",
)<{
  name: string;
}> {}

export class ServiceOperationFailed extends Data.TaggedError(
  "GCP.Run.ServiceOperationFailed",
)<{
  operation: string;
  message: string;
}> {}

export class ServiceOperationPending extends Data.TaggedError(
  "GCP.Run.ServiceOperationPending",
)<{
  operation: string;
}> {}

const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

const normalizeLocation = (location: string | undefined) =>
  lastSegment(location ?? DEFAULT_LOCATION).toLowerCase();

const resourceName = (project: string, location: string, serviceId: string) =>
  `projects/${project}/locations/${location}/services/${serviceId}`;

const parseName = (name: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const servicesAt = parts.lastIndexOf("services");
  const locationsAt = parts.lastIndexOf("locations");
  const projectsAt = parts.lastIndexOf("projects");
  return {
    project:
      projectsAt >= 0 && parts[projectsAt + 1] ? parts[projectsAt + 1]! : "",
    location:
      locationsAt >= 0 && parts[locationsAt + 1]
        ? parts[locationsAt + 1]!
        : DEFAULT_LOCATION,
    serviceId:
      servicesAt >= 0 && parts[servicesAt + 1]
        ? parts[servicesAt + 1]!
        : lastSegment(name),
  };
};

const userLabels = (
  labels: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalLabels(tagRecord(labels));

const userAnnotations = (
  annotations: Record<string, string | undefined> | null | undefined,
): Record<string, string> => tagRecord(annotations);

const recordsEqual = (
  left: Record<string, string>,
  right: Record<string, string>,
) => {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) => key === rightKeys[index] && left[key] === right[key],
    )
  );
};

const rfc1035 = (name: string): string => {
  let next = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!/^[a-z]/.test(next)) next = `s${next}`;
  next = next.slice(0, MAX_NAME_LENGTH).replace(/-+$/g, "");
  return next.length > 0 ? next : "service";
};

const toId = (id: string, serviceId: string | undefined, existing?: string) =>
  Effect.gen(function* () {
    if (serviceId !== undefined) return serviceId;
    if (existing !== undefined) return existing;
    return rfc1035(
      yield* createPhysicalName({
        id,
        maxLength: MAX_NAME_LENGTH,
        lowercase: true,
      }),
    );
  });

const desiredTemplate = (
  news: ServiceProps,
): cloudrun.GoogleCloudRunV2RevisionTemplate => {
  const template = news.template ?? {};
  return {
    ...template,
    containers: template.containers ?? [{ image: DEFAULT_IMAGE }],
  };
};

const normalizeDuration = (value: string | undefined) => {
  if (value === undefined) return undefined;
  const match = /^([0-9]+(?:\.[0-9]+)?)s$/.exec(value.trim());
  if (!match) return value;
  return `${Number(match[1])}s`;
};

const envFingerprint = (env: cloudrun.GoogleCloudRunV2EnvVarList | undefined) =>
  JSON.stringify(
    [...(env ?? [])]
      .map((item) => ({
        name: item.name ?? "",
        value: item.value ?? "",
        secret: item.valueSource?.secretKeyRef?.secret ?? "",
        version: item.valueSource?.secretKeyRef?.version ?? "",
      }))
      .sort((left, right) => left.name.localeCompare(right.name)),
  );

const containerNeedsSync = (
  desired: cloudrun.GoogleCloudRunV2ContainerList | undefined,
  observed: cloudrun.GoogleCloudRunV2ContainerList | undefined,
) => {
  const want = desired ?? [];
  const have = observed ?? [];
  if (want.length !== have.length) return true;
  return want.some((container, index) => {
    const current = have[index];
    if (current === undefined) return true;
    if ((container.image ?? "") !== (current.image ?? "")) return true;
    if (
      container.command !== undefined &&
      JSON.stringify(container.command) !==
        JSON.stringify(current.command ?? [])
    ) {
      return true;
    }
    if (
      container.args !== undefined &&
      JSON.stringify(container.args) !== JSON.stringify(current.args ?? [])
    ) {
      return true;
    }
    if (
      container.workingDir !== undefined &&
      container.workingDir !== (current.workingDir ?? "")
    ) {
      return true;
    }
    if (
      container.env !== undefined &&
      envFingerprint(container.env) !== envFingerprint(current.env)
    ) {
      return true;
    }
    if (
      container.ports !== undefined &&
      JSON.stringify(
        container.ports.map((port) => ({
          name: port.name ?? "",
          containerPort: port.containerPort ?? 0,
        })),
      ) !==
        JSON.stringify(
          (current.ports ?? []).map((port) => ({
            name: port.name ?? "",
            containerPort: port.containerPort ?? 0,
          })),
        )
    ) {
      return true;
    }
    if (container.resources?.limits !== undefined) {
      const wantLimits = tagRecord(container.resources.limits);
      const haveLimits = tagRecord(current.resources?.limits);
      for (const [key, value] of Object.entries(wantLimits)) {
        if (haveLimits[key] !== value) return true;
      }
    }
    if (
      container.resources?.cpuIdle !== undefined &&
      container.resources.cpuIdle !== current.resources?.cpuIdle
    ) {
      return true;
    }
    if (
      container.resources?.startupCpuBoost !== undefined &&
      container.resources.startupCpuBoost !== current.resources?.startupCpuBoost
    ) {
      return true;
    }
    if (
      container.name !== undefined &&
      container.name !== (current.name ?? "")
    ) {
      return true;
    }
    return false;
  });
};

const scalingFingerprint = (scaling: ServiceScaling | undefined) =>
  JSON.stringify({
    min: scaling?.minInstanceCount ?? null,
    max: scaling?.maxInstanceCount ?? null,
    mode: scaling?.scalingMode ?? "",
    manual: scaling?.manualInstanceCount ?? null,
  });

const trafficFingerprint = (traffic: TrafficTarget[] | undefined) =>
  JSON.stringify(
    (traffic ?? []).map((target) => ({
      type: target.type ?? "",
      revision: target.revision ?? "",
      percent: target.percent ?? 0,
      tag: target.tag ?? "",
    })),
  );

const audiencesFingerprint = (audiences: string[] | undefined) =>
  JSON.stringify([...(audiences ?? [])].sort());

const templateNeedsSync = (
  desired: cloudrun.GoogleCloudRunV2RevisionTemplate,
  observed: cloudrun.GoogleCloudRunV2RevisionTemplate | undefined,
) => {
  const current = observed ?? {};
  if (containerNeedsSync(desired.containers, current.containers)) {
    return true;
  }
  if (
    desired.timeout !== undefined &&
    normalizeDuration(desired.timeout) !== normalizeDuration(current.timeout)
  ) {
    return true;
  }
  if (
    desired.maxInstanceRequestConcurrency !== undefined &&
    desired.maxInstanceRequestConcurrency !==
      (current.maxInstanceRequestConcurrency ?? 0)
  ) {
    return true;
  }
  if (
    desired.serviceAccount !== undefined &&
    desired.serviceAccount !== (current.serviceAccount ?? "")
  ) {
    return true;
  }
  if (
    desired.executionEnvironment !== undefined &&
    desired.executionEnvironment !== (current.executionEnvironment ?? "")
  ) {
    return true;
  }
  if (
    desired.sessionAffinity !== undefined &&
    desired.sessionAffinity !== (current.sessionAffinity === true)
  ) {
    return true;
  }
  if (
    desired.encryptionKey !== undefined &&
    desired.encryptionKey !== (current.encryptionKey ?? "")
  ) {
    return true;
  }
  if (
    desired.revision !== undefined &&
    desired.revision !== (current.revision ?? "")
  ) {
    return true;
  }
  if (
    desired.scaling !== undefined &&
    scalingFingerprint(desired.scaling) !== scalingFingerprint(current.scaling)
  ) {
    return true;
  }
  if (
    desired.vpcAccess !== undefined &&
    JSON.stringify(desired.vpcAccess) !==
      JSON.stringify(current.vpcAccess ?? {})
  ) {
    return true;
  }
  if (
    desired.volumes !== undefined &&
    JSON.stringify(desired.volumes) !== JSON.stringify(current.volumes ?? [])
  ) {
    return true;
  }
  if (
    desired.labels !== undefined &&
    !recordsEqual(
      userAnnotations(desired.labels),
      userAnnotations(current.labels),
    )
  ) {
    return true;
  }
  if (
    desired.annotations !== undefined &&
    !recordsEqual(
      userAnnotations(desired.annotations),
      userAnnotations(current.annotations),
    )
  ) {
    return true;
  }
  return false;
};

const toAttrs = (
  service: cloudrun.GoogleCloudRunV2Service,
  project: string,
) => {
  const name = service.name ?? "";
  const parsed = parseName(name);
  return {
    name,
    serviceId: parsed.serviceId,
    project: parsed.project || project,
    location: parsed.location,
    labels: userLabels(service.labels),
    annotations: userAnnotations(service.annotations),
    description: service.description,
    uri: service.uri,
    urls: service.urls ?? [],
    uid: service.uid,
    ingress: service.ingress,
    invokerIamDisabled: service.invokerIamDisabled === true,
    latestCreatedRevision: service.latestCreatedRevision,
    latestReadyRevision: service.latestReadyRevision,
    terminalConditionState: service.terminalCondition?.state,
    reconciling: service.reconciling === true,
    generation: service.generation,
    createTime: service.createTime,
    updateTime: service.updateTime,
  };
};

const getByName = (name: string) =>
  cloudrun
    .getProjectsLocationsServices({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const isNotFoundStatus = (error: cloudrun.GoogleRpcStatus | undefined) => {
  if (error === undefined) return false;
  if (error.code === 5) return true;
  return (error.message ?? "").toLowerCase().includes("not found");
};

const waitForOperation = (
  operation: cloudrun.GoogleLongrunningOperation,
  options?: { notFoundOk?: boolean },
) =>
  Effect.gen(function* () {
    const name = operation.name;
    if (operation.done === true) {
      if (operation.error) {
        if (options?.notFoundOk === true && isNotFoundStatus(operation.error)) {
          return operation;
        }
        return yield* new ServiceOperationFailed({
          operation: name ?? "",
          message: operation.error.message ?? "operation failed",
        });
      }
      return operation;
    }
    if (name === undefined || name.length === 0) {
      return yield* new ServiceOperationFailed({
        operation: "",
        message: "operation is missing a name",
      });
    }

    const getOperation = cloudrun.getProjectsLocationsOperations({ name });
    const resolved =
      options?.notFoundOk === true
        ? getOperation.pipe(
            Effect.catchTag("NotFound", () =>
              Effect.succeed({
                name,
                done: true,
              } satisfies cloudrun.GoogleLongrunningOperation),
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
        () => new ServiceOperationPending({ operation: name }),
      ),
      Effect.flatMap((current) => {
        const status = current.error;
        const ignoreNotFound =
          options?.notFoundOk === true && isNotFoundStatus(status);
        return status && !ignoreNotFound
          ? Effect.fail(
              new ServiceOperationFailed({
                operation: name,
                message: status.message ?? "operation failed",
              }),
            )
          : Effect.succeed(current);
      }),
      Effect.retry({
        while: (error) => error._tag === "GCP.Run.ServiceOperationPending",
        times: 10,
        schedule: Schedule.spaced("5 seconds"),
      }),
    );
  });

const isPendingService = (service: cloudrun.GoogleCloudRunV2Service) => {
  const state = service.terminalCondition?.state ?? "";
  return (
    service.reconciling === true ||
    state === "CONDITION_PENDING" ||
    state === "CONDITION_RECONCILING" ||
    state === "" ||
    state === "STATE_UNSPECIFIED"
  );
};

const waitUntilReady = (name: string) =>
  getByName(name).pipe(
    Effect.filterOrFail(
      (service): service is cloudrun.GoogleCloudRunV2Service =>
        service !== undefined && service.deleteTime === undefined,
      () => new ServiceNotResolved({ name }),
    ),
    Effect.filterOrFail(
      (service) =>
        (service.terminalCondition?.state ?? "") !== "CONDITION_FAILED",
      (service) =>
        new ServiceNotReady({
          name,
          state: service.terminalCondition?.state ?? "",
          message: service.terminalCondition?.message ?? "revision failed",
        }),
    ),
    Effect.filterOrFail(
      (service) => !isPendingService(service),
      (service) =>
        new ServiceReconciling({
          name,
          state: service.terminalCondition?.state || "reconciling",
        }),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.Run.ServiceReconciling" ||
        error._tag === "GCP.Run.ServiceNotResolved",
      times: 10,
      schedule: Schedule.spaced("4 seconds"),
    }),
  );

const waitUntilGone = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((service) =>
      service === undefined
        ? Effect.void
        : Effect.fail(new ServiceStillExists({ name })),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.Run.ServiceStillExists",
      times: 10,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

const toCreateBody = (
  news: ServiceProps,
  labels: Record<string, string>,
): cloudrun.GoogleCloudRunV2Service => ({
  labels,
  annotations: news.annotations,
  description: news.description,
  ingress: news.ingress,
  invokerIamDisabled: news.invokerIamDisabled,
  defaultUriDisabled: news.defaultUriDisabled,
  iapEnabled: news.iapEnabled,
  customAudiences: news.customAudiences,
  scaling: news.scaling,
  traffic: news.traffic,
  template: desiredTemplate(news),
});

export const ServiceProvider = () =>
  Provider.succeed(Service, {
    stables: ["name", "serviceId", "project", "location", "uid", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId = olds?.serviceId ?? output?.serviceId;
      const nextId = news.serviceId ?? previousId;
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
      );
      const nextLocation = normalizeLocation(news.location ?? output?.location);
      const idChanged =
        previousId !== undefined &&
        nextId !== undefined &&
        nextId !== previousId;
      const locationChanged = previousLocation !== nextLocation;
      if (!idChanged && !locationChanged) return undefined;
      return { action: "replace" as const, deleteFirst: false };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const serviceId = yield* toId(id, olds?.serviceId, output?.serviceId);
      const location = normalizeLocation(olds?.location ?? output?.location);
      const name =
        output?.name ?? resourceName(env.project, location, serviceId);
      const existing = yield* getByName(name);
      if (existing === undefined || existing.deleteTime !== undefined) {
        return undefined;
      }
      const attrs = toAttrs(existing, env.project);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        return yield* cloudrun.listProjectsLocationsServices
          .pages({
            parent: `projects/${env.project}/locations/-`,
            pageSize: 1000,
          })
          .pipe(
            Stream.flatMap((page) => Stream.fromIterable(page.services ?? [])),
            Stream.filter(
              (service) =>
                service.deleteTime === undefined &&
                Object.keys(service.labels ?? {}).some((key) =>
                  key.startsWith("alchemy-"),
                ),
            ),
            Stream.map((service) => toAttrs(service, env.project)),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
          );
      }),

    reconcile: Effect.fn(function* ({ id, news, output, bindings, session }) {
      const env = yield* GcpEnvironment.current;
      const serviceId = yield* toId(id, news.serviceId, output?.serviceId);
      const location = normalizeLocation(news.location ?? output?.location);
      const name = resourceName(env.project, location, serviceId);
      const parent = `projects/${env.project}/locations/${location}`;
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const desiredAnnotations = news.annotations;
      const template = desiredTemplate(news);
      const serviceAccount =
        template.serviceAccount && template.serviceAccount.length > 0
          ? template.serviceAccount
          : yield* defaultComputeServiceAccount(env.project);
      template.serviceAccount = serviceAccount;
      const collected = yield* applyHostBindings({
        project: env.project,
        serviceAccount,
        bindings: bindings as ResourceBinding<GcpHostBinding>[],
      });
      const runtimeEnv = { ...collected.env, ...news.env };
      if (news.main !== undefined) {
        const images = yield* makeImageSource;
        const handler = news.handler ?? "default";
        const port = news.port ?? 8080;
        const image = yield* images.resolve({
          id,
          source: {
            main: news.main,
            handler,
            build: news.build,
          },
          repositoryName: rfc1035(`${serviceId}-src`),
          location,
          port,
          isExternal: news.isExternal,
          bootstrap: (importPath: string) => `
import { bootstrap } from "alchemy/Runtime/Bootstrap/CloudRun";

globalThis.__ALCHEMY_RUNTIME__ = true;
const { ${handler}: entrypoint } = await import(${JSON.stringify(importPath)});

await bootstrap(entrypoint);
`,
          session,
        });
        const existing = template.containers?.[0] ?? {};
        template.containers = [
          {
            ...existing,
            image: image.imageUri,
            ports: existing.ports ?? [{ containerPort: port }],
            env: [
              ...(existing.env ?? []),
              ...Object.entries(runtimeEnv).map(([envName, value]) => ({
                name: envName,
                value:
                  typeof value === "string" ? value : JSON.stringify(value),
              })),
            ],
          },
        ];
      } else if (Object.keys(runtimeEnv).length > 0) {
        const existing = template.containers?.[0];
        if (existing !== undefined) {
          existing.env = [
            ...(existing.env ?? []),
            ...Object.entries(runtimeEnv).map(([envName, value]) => ({
              name: envName,
              value: typeof value === "string" ? value : JSON.stringify(value),
            })),
          ];
        }
      }

      let current = yield* getByName(name);
      if (current?.deleteTime !== undefined) {
        yield* waitUntilGone(name);
        current = undefined;
      }

      if (current === undefined) {
        const created = yield* cloudrun
          .createProjectsLocationsServices({
            parent,
            serviceId,
            body: toCreateBody(news, desiredLabels),
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          yield* waitForOperation(created);
        }
        current = yield* waitUntilReady(name);
      }

      if (current === undefined) {
        return yield* new ServiceNotResolved({ name });
      }

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const descriptionChanged =
        (current.description ?? "") !== (news.description ?? "");
      const annotationsChanged =
        desiredAnnotations !== undefined &&
        !recordsEqual(
          userAnnotations(current.annotations),
          userAnnotations(desiredAnnotations),
        );
      const ingressChanged =
        news.ingress !== undefined && (current.ingress ?? "") !== news.ingress;
      const invokerChanged =
        news.invokerIamDisabled !== undefined &&
        (current.invokerIamDisabled === true) !== news.invokerIamDisabled;
      const defaultUriChanged =
        news.defaultUriDisabled !== undefined &&
        (current.defaultUriDisabled === true) !== news.defaultUriDisabled;
      const iapChanged =
        news.iapEnabled !== undefined &&
        (current.iapEnabled === true) !== news.iapEnabled;
      const audiencesChanged =
        news.customAudiences !== undefined &&
        audiencesFingerprint(current.customAudiences) !==
          audiencesFingerprint(news.customAudiences);
      const scalingChanged =
        news.scaling !== undefined &&
        scalingFingerprint(current.scaling) !==
          scalingFingerprint(news.scaling);
      const trafficChanged =
        news.traffic !== undefined &&
        trafficFingerprint(current.traffic) !==
          trafficFingerprint(news.traffic);
      const templateChanged = templateNeedsSync(template, current.template);

      if (
        labelsChanged ||
        descriptionChanged ||
        annotationsChanged ||
        ingressChanged ||
        invokerChanged ||
        defaultUriChanged ||
        iapChanged ||
        audiencesChanged ||
        scalingChanged ||
        trafficChanged ||
        templateChanged
      ) {
        const updateMask = [
          labelsChanged ? "labels" : undefined,
          descriptionChanged ? "description" : undefined,
          annotationsChanged ? "annotations" : undefined,
          ingressChanged ? "ingress" : undefined,
          invokerChanged ? "invokerIamDisabled" : undefined,
          defaultUriChanged ? "defaultUriDisabled" : undefined,
          iapChanged ? "iapEnabled" : undefined,
          audiencesChanged ? "customAudiences" : undefined,
          scalingChanged ? "scaling" : undefined,
          trafficChanged ? "traffic" : undefined,
          templateChanged ? "template" : undefined,
        ].filter((field): field is string => field !== undefined);

        const patched = yield* cloudrun.patchProjectsLocationsServices({
          name,
          updateMask: updateMask.join(","),
          body: {
            name,
            labels: desiredLabels,
            description: news.description,
            annotations: desiredAnnotations,
            ingress: news.ingress,
            invokerIamDisabled: news.invokerIamDisabled,
            defaultUriDisabled: news.defaultUriDisabled,
            iapEnabled: news.iapEnabled,
            customAudiences: news.customAudiences,
            scaling: news.scaling,
            traffic: news.traffic,
            template,
          },
        });
        yield* waitForOperation(patched);
        current = yield* waitUntilReady(name);
      }

      if (current === undefined) {
        return yield* new ServiceNotResolved({ name });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* cloudrun
        .deleteProjectsLocationsServices({ name: output.name })
        .pipe(
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("2 seconds"),
          }),
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        );
      if (operation !== undefined) {
        yield* waitForOperation(operation, { notFoundOk: true });
      }
      yield* waitUntilGone(output.name);
    }),
  });
