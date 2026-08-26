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
const DEFAULT_IMAGE = "us-docker.pkg.dev/cloudrun/container/worker-pool";
const MAX_NAME_LENGTH = 49;

export type WorkerPoolEnvVar = {
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

export type WorkerPoolContainer = {
  /** DNS_LABEL container name. */
  name?: string;
  /**
   * Container image (Artifact Registry, GCR, or Docker Hub). Required
   * unless `template` is omitted, in which case the public Cloud Run
   * worker-pool image is used.
   */
  image?: string;
  /** Entrypoint. */
  command?: string[];
  /** Arguments to the entrypoint. */
  args?: string[];
  /** Environment variables. */
  env?: WorkerPoolEnvVar[];
  /** CPU / memory / GPU requirements. */
  resources?: {
    /** Resource limits. Keys: `cpu`, `memory`, `nvidia.com/gpu`. */
    limits?: Record<string, string>;
    /** Allocate CPU only during requests. */
    cpuIdle?: boolean;
    /** Boost CPU on startup to reduce cold starts. */
    startupCpuBoost?: boolean;
  };
  /** Working directory. */
  workingDir?: string;
  /** Volume mounts. Names must match `volumes`. */
  volumeMounts?: Array<{
    name: string;
    mountPath: string;
    subPath?: string;
  }>;
  /** Containers that must start before this one. */
  dependsOn?: string[];
};

export type WorkerPoolRevisionTemplate = {
  /** Containers that make up the revision. */
  containers?: WorkerPoolContainer[];
  /** Runtime service account email. Defaults to the project Compute SA. */
  serviceAccount?: string;
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
  /** Unique revision name. Generated from the worker pool name if omitted. */
  revision?: string;
  /** Node selector (e.g. GPU accelerator). */
  nodeSelector?: cloudrun.GoogleCloudRunV2NodeSelector;
  /** True if GPU zonal redundancy is disabled. */
  gpuZonalRedundancyDisabled?: boolean;
  /** Service mesh connectivity. */
  serviceMesh?: cloudrun.GoogleCloudRunV2ServiceMesh;
};

export type InstanceSplit = {
  /**
   * Allocation type (`INSTANCE_SPLIT_ALLOCATION_TYPE_LATEST` or
   * `INSTANCE_SPLIT_ALLOCATION_TYPE_REVISION`).
   */
  type?: string;
  /** Revision to assign instances to when allocating by revision. */
  revision?: string;
  /** Percent of instances (0–100). */
  percent?: number;
};

export type WorkerPoolScaling = {
  /** Total instances in manual scaling mode. */
  manualInstanceCount?: number;
};

export type WorkerPoolBinaryAuthorization = {
  /** Use the project's default Binary Authorization policy. */
  useDefault?: boolean;
  /** Breakglass justification. Requires `useDefault`. */
  breakglassJustification?: string;
  /** Policy path `projects/{project}/platforms/cloudRun/{policy}`. */
  policy?: string;
};

export type WorkerPoolProps = PlatformProps & {
  /**
   * Worker pool id (the `{workerPool}` segment of
   * `projects/{project}/locations/{location}/workerPools/{workerPool}`).
   * If omitted, a unique name is generated from the stack, stage, and
   * logical id. Must begin with a letter, not end with a hyphen, and be
   * fewer than 50 characters. Immutable — changing it replaces the pool.
   */
  workerPoolId?: string;
  /**
   * Region (`us-central1`, `europe-west1`, …). Immutable — changing it
   * replaces the pool. `US-CENTRAL1` is accepted and normalized to
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
   * Launch stage (`GA`, `BETA`, `ALPHA`). Defaults to GA.
   */
  launchStage?: string;
  /**
   * Binary Authorization settings.
   */
  binaryAuthorization?: WorkerPoolBinaryAuthorization;
  /**
   * Instance split. Empty / omitted sends 100% to the latest Ready
   * revision.
   */
  instanceSplits?: InstanceSplit[];
  /**
   * Worker-pool-level scaling (manual instance count).
   */
  scaling?: WorkerPoolScaling;
  /**
   * Revision template. If omitted, a single container runs the public
   * Cloud Run worker-pool image. The Effect-native `main` form fills
   * `image` for you.
   */
  template?: WorkerPoolRevisionTemplate;
  /**
   * Module entrypoint for an Effect-native worker pool (typically
   * `import.meta.url`). Alchemy bundles the program, builds a container,
   * and deploys the pool. Bindings attach env + IAM onto the runtime SA.
   */
  main?: string;
  /**
   * Named export to load from `main`.
   * @default "default"
   */
  handler?: string;
  /**
   * Additional environment variables for the Effect-native container.
   */
  env?: Record<string, any>;
  /**
   * Bundler configuration for `main`.
   */
  build?: Bundle.BundleConfig;
};

export type WorkerPool = Resource<
  "GCP.Run.WorkerPool",
  WorkerPoolProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/workerPools/{workerPool}`. */
    name: string;
    /** Worker pool id (last path segment). */
    workerPoolId: string;
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
    /** Server-assigned UUID. */
    uid: string | undefined;
    /** Launch stage. */
    launchStage: string | undefined;
    /** Manual instance count. */
    manualInstanceCount: number | undefined;
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
    /** Image of the first container. */
    image: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  GcpHostBinding,
  Providers
>;

export type WorkerPoolRuntimeContext = HostRuntimeContext;
export type WorkerPoolServices = Credentials | GcpEnvironment | ServerHost;
export type WorkerPoolShape = Main<WorkerPoolServices>;

/**
 * A Cloud Run worker pool (pull-based revision + instance split).
 *
 * Changing `workerPoolId` or `location` replaces the pool. Updates to
 * `template` create a new revision.
 *
 * ### Creating a Worker Pool
 * **Example:** Generated name, default worker image
 * ```typescript
 * const pool = yield* GCP.Run.WorkerPool("workers", {});
 * ```
 *
 * **Example:** Explicit id, image, env, and labels
 * ```typescript
 * const pool = yield* GCP.Run.WorkerPool("workers", {
 *   workerPoolId: "order-workers",
 *   location: "us-central1",
 *   description: "order pull workers",
 *   labels: { env: "prod" },
 *   scaling: { manualInstanceCount: 1 },
 *   template: {
 *     containers: [
 *       {
 *         image: "us-docker.pkg.dev/cloudrun/container/worker-pool",
 *         env: [{ name: "ENV", value: "prod" }],
 *       },
 *     ],
 *   },
 * });
 * ```
 *
 * ### Reading a Worker Pool
 * **Example:** Get the live worker pool
 * ```typescript
 * const getWorkerPool = yield* GCP.Run.GetWorkerPool(pool);
 * const live = yield* getWorkerPool();
 * ```
 *
 * ### Effect-native Worker Pool with bindings
 * **Example:** Pull workers with Memorystore
 * ```typescript
 * export class Workers extends GCP.Run.WorkerPool<Workers>()(
 *   "Workers",
 *   { main: import.meta.url, scaling: { manualInstanceCount: 1 } },
 *   Effect.gen(function* () {
 *     const redis = yield* GCP.Redis.ReadWriteRedis(cache);
 *     return {
 *       run: redis.set("worker", "up"),
 *     };
 *   }).pipe(Effect.provide(GCP.Redis.ReadWriteRedisHttp)),
 * ) {}
 * ```
 *
 * @resource
 * @product GCP
 * @category Run
 */
export const WorkerPool: Platform<
  WorkerPool,
  WorkerPoolServices,
  WorkerPoolShape,
  WorkerPoolRuntimeContext
> = Platform("GCP.Run.WorkerPool", {
  createRuntimeContext: createHostRuntimeContext("GCP.Run.WorkerPool") as (
    id: string,
  ) => WorkerPoolRuntimeContext,
});

export class WorkerPoolNotResolved extends Data.TaggedError(
  "GCP.Run.WorkerPoolNotResolved",
)<{
  name: string;
}> {}

export class WorkerPoolNotReady extends Data.TaggedError(
  "GCP.Run.WorkerPoolNotReady",
)<{
  name: string;
  state: string;
  message: string;
}> {}

export class WorkerPoolReconciling extends Data.TaggedError(
  "GCP.Run.WorkerPoolReconciling",
)<{
  name: string;
  state: string;
}> {}

export class WorkerPoolStillExists extends Data.TaggedError(
  "GCP.Run.WorkerPoolStillExists",
)<{
  name: string;
}> {}

export class WorkerPoolOperationFailed extends Data.TaggedError(
  "GCP.Run.WorkerPoolOperationFailed",
)<{
  operation: string;
  message: string;
}> {}

export class WorkerPoolOperationPending extends Data.TaggedError(
  "GCP.Run.WorkerPoolOperationPending",
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

const resourceName = (
  project: string,
  location: string,
  workerPoolId: string,
) => `projects/${project}/locations/${location}/workerPools/${workerPoolId}`;

const parseName = (name: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const poolsAt = parts.lastIndexOf("workerPools");
  const locationsAt = parts.lastIndexOf("locations");
  const projectsAt = parts.lastIndexOf("projects");
  return {
    project:
      projectsAt >= 0 && parts[projectsAt + 1] ? parts[projectsAt + 1]! : "",
    location:
      locationsAt >= 0 && parts[locationsAt + 1]
        ? parts[locationsAt + 1]!
        : DEFAULT_LOCATION,
    workerPoolId:
      poolsAt >= 0 && parts[poolsAt + 1]
        ? parts[poolsAt + 1]!
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
  if (!/^[a-z]/.test(next)) next = `w${next}`;
  next = next.slice(0, MAX_NAME_LENGTH).replace(/-+$/g, "");
  return next.length > 0 ? next : "workerpool";
};

const toId = (
  id: string,
  workerPoolId: string | undefined,
  existing?: string,
) =>
  Effect.gen(function* () {
    if (workerPoolId !== undefined) return workerPoolId;
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
  news: WorkerPoolProps,
): cloudrun.GoogleCloudRunV2WorkerPoolRevisionTemplate => {
  const template = news.template ?? {};
  return {
    ...template,
    containers: template.containers ?? [{ image: DEFAULT_IMAGE }],
  };
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
    if (
      container.volumeMounts !== undefined &&
      JSON.stringify(container.volumeMounts) !==
        JSON.stringify(current.volumeMounts ?? [])
    ) {
      return true;
    }
    if (
      container.dependsOn !== undefined &&
      JSON.stringify(container.dependsOn) !==
        JSON.stringify(current.dependsOn ?? [])
    ) {
      return true;
    }
    return false;
  });
};

const scalingFingerprint = (scaling: WorkerPoolScaling | undefined) =>
  JSON.stringify({
    manual: scaling?.manualInstanceCount ?? null,
  });

const instanceSplitFingerprint = (splits: InstanceSplit[] | undefined) =>
  JSON.stringify(
    (splits ?? []).map((split) => ({
      type: split.type ?? "",
      revision: split.revision ?? "",
      percent: split.percent ?? 0,
    })),
  );

const stable = (value: unknown): string =>
  JSON.stringify(value, (_key, current) => {
    if (current && typeof current === "object" && !Array.isArray(current)) {
      return Object.fromEntries(
        Object.entries(current as Record<string, unknown>)
          .filter(([, item]) => item !== undefined)
          .sort(([a], [b]) => a.localeCompare(b)),
      );
    }
    return current;
  });

const templateNeedsSync = (
  desired: cloudrun.GoogleCloudRunV2WorkerPoolRevisionTemplate,
  observed: cloudrun.GoogleCloudRunV2WorkerPoolRevisionTemplate | undefined,
) => {
  const current = observed ?? {};
  if (containerNeedsSync(desired.containers, current.containers)) {
    return true;
  }
  if (
    desired.serviceAccount !== undefined &&
    desired.serviceAccount !== (current.serviceAccount ?? "")
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
    desired.gpuZonalRedundancyDisabled !== undefined &&
    desired.gpuZonalRedundancyDisabled !==
      (current.gpuZonalRedundancyDisabled === true)
  ) {
    return true;
  }
  if (
    desired.vpcAccess !== undefined &&
    stable(desired.vpcAccess) !== stable(current.vpcAccess ?? {})
  ) {
    return true;
  }
  if (
    desired.volumes !== undefined &&
    stable(desired.volumes) !== stable(current.volumes ?? [])
  ) {
    return true;
  }
  if (
    desired.nodeSelector !== undefined &&
    stable(desired.nodeSelector) !== stable(current.nodeSelector ?? {})
  ) {
    return true;
  }
  if (
    desired.serviceMesh !== undefined &&
    stable(desired.serviceMesh) !== stable(current.serviceMesh ?? {})
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
  pool: cloudrun.GoogleCloudRunV2WorkerPool,
  project: string,
) => {
  const name = pool.name ?? "";
  const parsed = parseName(name);
  return {
    name,
    workerPoolId: parsed.workerPoolId,
    project: parsed.project || project,
    location: parsed.location,
    labels: userLabels(pool.labels),
    annotations: userAnnotations(pool.annotations),
    description: pool.description,
    uid: pool.uid,
    launchStage: pool.launchStage,
    manualInstanceCount: pool.scaling?.manualInstanceCount,
    latestCreatedRevision: pool.latestCreatedRevision,
    latestReadyRevision: pool.latestReadyRevision,
    terminalConditionState: pool.terminalCondition?.state,
    reconciling: pool.reconciling === true,
    generation: pool.generation,
    image: pool.template?.containers?.[0]?.image,
    createTime: pool.createTime,
    updateTime: pool.updateTime,
  };
};

const getByName = (name: string) =>
  cloudrun
    .getProjectsLocationsWorkerPools({ name })
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
        return yield* new WorkerPoolOperationFailed({
          operation: name ?? "",
          message: operation.error.message ?? "operation failed",
        });
      }
      return operation;
    }
    if (name === undefined || name.length === 0) {
      return yield* new WorkerPoolOperationFailed({
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
        () => new WorkerPoolOperationPending({ operation: name }),
      ),
      Effect.flatMap((current) => {
        const status = current.error;
        const ignoreNotFound =
          options?.notFoundOk === true && isNotFoundStatus(status);
        return status && !ignoreNotFound
          ? Effect.fail(
              new WorkerPoolOperationFailed({
                operation: name,
                message: status.message ?? "operation failed",
              }),
            )
          : Effect.succeed(current);
      }),
      Effect.retry({
        while: (error) => error._tag === "GCP.Run.WorkerPoolOperationPending",
        times: 10,
        schedule: Schedule.spaced("5 seconds"),
      }),
    );
  });

const isPendingPool = (pool: cloudrun.GoogleCloudRunV2WorkerPool) => {
  const state = pool.terminalCondition?.state ?? "";
  return (
    pool.reconciling === true ||
    state === "CONDITION_PENDING" ||
    state === "CONDITION_RECONCILING" ||
    state === "" ||
    state === "STATE_UNSPECIFIED"
  );
};

const waitUntilReady = (name: string) =>
  getByName(name).pipe(
    Effect.filterOrFail(
      (pool): pool is cloudrun.GoogleCloudRunV2WorkerPool =>
        pool !== undefined && pool.deleteTime === undefined,
      () => new WorkerPoolNotResolved({ name }),
    ),
    Effect.filterOrFail(
      (pool) => (pool.terminalCondition?.state ?? "") !== "CONDITION_FAILED",
      (pool) =>
        new WorkerPoolNotReady({
          name,
          state: pool.terminalCondition?.state ?? "",
          message: pool.terminalCondition?.message ?? "revision failed",
        }),
    ),
    Effect.filterOrFail(
      (pool) => !isPendingPool(pool),
      (pool) =>
        new WorkerPoolReconciling({
          name,
          state: pool.terminalCondition?.state || "reconciling",
        }),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.Run.WorkerPoolReconciling" ||
        error._tag === "GCP.Run.WorkerPoolNotResolved",
      times: 10,
      schedule: Schedule.spaced("4 seconds"),
    }),
  );

const waitUntilGone = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((pool) =>
      pool === undefined
        ? Effect.void
        : Effect.fail(new WorkerPoolStillExists({ name })),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.Run.WorkerPoolStillExists",
      times: 10,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

const toCreateBody = (
  news: WorkerPoolProps,
  labels: Record<string, string>,
): cloudrun.GoogleCloudRunV2WorkerPool => ({
  labels,
  annotations: news.annotations,
  description: news.description,
  launchStage: news.launchStage,
  binaryAuthorization: news.binaryAuthorization,
  instanceSplits: news.instanceSplits,
  scaling: news.scaling,
  template: desiredTemplate(news),
});

const listAt = (project: string, location: string) =>
  cloudrun.listProjectsLocationsWorkerPools
    .pages({
      parent: `projects/${project}/locations/${location}`,
      pageSize: 1000,
    })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.workerPools ?? [])),
      Stream.filter(
        (pool) =>
          pool.deleteTime === undefined &&
          Object.keys(pool.labels ?? {}).some((key) =>
            key.startsWith("alchemy-"),
          ),
      ),
      Stream.map((pool) => toAttrs(pool, project)),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
    );

export const WorkerPoolProvider = () =>
  Provider.succeed(WorkerPool, {
    stables: [
      "name",
      "workerPoolId",
      "project",
      "location",
      "uid",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId = olds?.workerPoolId ?? output?.workerPoolId;
      const nextId = news.workerPoolId ?? previousId;
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
      const workerPoolId = yield* toId(
        id,
        olds?.workerPoolId,
        output?.workerPoolId,
      );
      const location = normalizeLocation(olds?.location ?? output?.location);
      const name =
        output?.name ?? resourceName(env.project, location, workerPoolId);
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
        // WorkerPools list rejects the `-` wildcard; Services/Jobs accept it.
        return yield* listAt(env.project, "-").pipe(
          Effect.catchTag(["NotFound", "Forbidden"], () =>
            listAt(env.project, DEFAULT_LOCATION),
          ),
          Effect.catchIf(
            (error) => error._tag === "UnknownGCPError",
            () => listAt(env.project, DEFAULT_LOCATION),
          ),
        );
      }),

    reconcile: Effect.fn(function* ({ id, news, output, bindings, session }) {
      const env = yield* GcpEnvironment.current;
      const workerPoolId = yield* toId(
        id,
        news.workerPoolId,
        output?.workerPoolId,
      );
      const location = normalizeLocation(news.location ?? output?.location);
      const name = resourceName(env.project, location, workerPoolId);
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
        const image = yield* images.resolve({
          id,
          source: {
            main: news.main,
            handler,
            build: news.build,
          },
          repositoryName: rfc1035(`${workerPoolId}-src`),
          location,
          isExternal: news.isExternal,
          bootstrap: (importPath: string) => `
import { bootstrap } from "alchemy/Runtime/Bootstrap/CloudRunJob";

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
          .createProjectsLocationsWorkerPools({
            parent,
            workerPoolId,
            body: toCreateBody(news, desiredLabels),
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          yield* waitForOperation(created);
        }
        current = yield* waitUntilReady(name);
      }

      if (current === undefined) {
        return yield* new WorkerPoolNotResolved({ name });
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
      const launchStageChanged =
        news.launchStage !== undefined &&
        (current.launchStage ?? "GA") !== news.launchStage;
      const binaryAuthorizationChanged =
        news.binaryAuthorization !== undefined &&
        stable(news.binaryAuthorization) !==
          stable(current.binaryAuthorization);
      const scalingChanged =
        news.scaling !== undefined &&
        scalingFingerprint(current.scaling) !==
          scalingFingerprint(news.scaling);
      const instanceSplitsChanged =
        news.instanceSplits !== undefined &&
        instanceSplitFingerprint(current.instanceSplits) !==
          instanceSplitFingerprint(news.instanceSplits);
      const templateChanged =
        news.template !== undefined &&
        templateNeedsSync(template, current.template);

      if (
        labelsChanged ||
        descriptionChanged ||
        annotationsChanged ||
        launchStageChanged ||
        binaryAuthorizationChanged ||
        scalingChanged ||
        instanceSplitsChanged ||
        templateChanged
      ) {
        const updateMask = [
          labelsChanged ? "labels" : undefined,
          descriptionChanged ? "description" : undefined,
          annotationsChanged ? "annotations" : undefined,
          launchStageChanged ? "launchStage" : undefined,
          binaryAuthorizationChanged ? "binaryAuthorization" : undefined,
          scalingChanged ? "scaling" : undefined,
          instanceSplitsChanged ? "instanceSplits" : undefined,
          templateChanged ? "template" : undefined,
        ].filter((field): field is string => field !== undefined);

        const patched = yield* cloudrun.patchProjectsLocationsWorkerPools({
          name,
          updateMask: updateMask.join(","),
          body: {
            name,
            labels: desiredLabels,
            description: news.description,
            annotations: desiredAnnotations,
            launchStage: news.launchStage,
            binaryAuthorization: news.binaryAuthorization,
            scaling: news.scaling,
            instanceSplits: news.instanceSplits,
            template,
          },
        });
        yield* waitForOperation(patched);
        current = yield* waitUntilReady(name);
      }

      if (current === undefined) {
        return yield* new WorkerPoolNotResolved({ name });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* cloudrun
        .deleteProjectsLocationsWorkerPools({ name: output.name })
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
