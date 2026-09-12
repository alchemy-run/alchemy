import * as aiplatform from "@distilled.cloud/gcp/aiplatform_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { tagRecord } from "../../Tags.ts";
import { GcpEnvironment } from "../Environment.ts";
import {
  createInternalLabels,
  diffLabels,
  hasAlchemyLabels,
  toLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import { resourceNameFromOperation, waitForOperation } from "./operations.ts";
import {
  AiPlatformNotResolved,
  AiPlatformStillExists,
  DEFAULT_LOCATION,
  collectPages,
  jsonEqual,
  locationParent,
  normalizeLocation,
  parseResourceName,
  toPhysicalId,
  userLabels,
  type DiskSpec,
  type EncryptionSpec,
  type MachineSpec,
} from "./shared.ts";

const COLLECTION = "persistentResources";
const DEFAULT_MACHINE_TYPE = "n1-standard-4";
const DEFAULT_REPLICA_COUNT = "1";

export type ResourcePoolAutoscalingSpec = {
  /** Minimum replicas (must be > 0 for Persistent Resource). */
  minReplicaCount?: string;
  /** Maximum replicas. */
  maxReplicaCount?: string;
};

export type ResourcePool = {
  /**
   * Unique id within the PersistentResource. Generated if omitted.
   */
  id?: string;
  /** Machine spec. Immutable. */
  machineSpec?: MachineSpec;
  /** Replica count (string). @default "1" */
  replicaCount?: string;
  /** Disk spec. */
  diskSpec?: DiskSpec;
  /** Autoscaling spec. */
  autoscalingSpec?: ResourcePoolAutoscalingSpec;
};

export type RaySpec = {
  /** Default Ray image URI. */
  imageUri?: string;
  /** Per-pool Ray images keyed by resource pool id. */
  resourcePoolImages?: Record<string, string>;
  /** Resource pool that serves as the Ray head node. */
  headNodeResourcePoolId?: string;
  /** Disable Ray OSS log export. */
  rayLogsDisabled?: boolean;
  /** Disable Ray metrics. */
  rayMetricsDisabled?: boolean;
};

export type ServiceAccountSpec = {
  /** Enforce a custom service account for workloads. */
  enableCustomServiceAccount?: boolean;
  /** Service account email. */
  serviceAccount?: string;
};

export type PersistentResourceProps = {
  /**
   * Persistent resource id. If omitted, a unique RFC1035 name is
   * generated. Must match `/^[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/`.
   * Immutable — changing it replaces the resource.
   */
  persistentResourceId?: string;
  /**
   * Vertex AI location. Immutable — changing it replaces the resource.
   * @default "us-central1"
   */
  location?: string;
  /**
   * Display name (max 128 UTF-8 characters). Defaults to the resource id.
   */
  displayName?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
  /**
   * Resource pools. At least one pool is required. Pool machine specs
   * are immutable — changing them replaces the resource.
   */
  resourcePools?: ResourcePool[];
  /**
   * VPC network to peer (`projects/{project}/global/networks/{network}`).
   * Immutable.
   */
  network?: string;
  /**
   * Reserved IP ranges under the VPC.
   */
  reservedIpRanges?: string[];
  /**
   * Customer-managed encryption key. Immutable.
   */
  encryptionSpec?: EncryptionSpec;
  /**
   * Ray cluster configuration.
   */
  raySpec?: RaySpec;
  /**
   * Workload identity / custom service account.
   */
  serviceAccountSpec?: ServiceAccountSpec;
};

export type PersistentResource = Resource<
  "GCP.AIPlatform.PersistentResource",
  PersistentResourceProps,
  {
    /** Full resource name. */
    name: string;
    /** Persistent resource id (last path segment). */
    persistentResourceId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Display name. */
    displayName: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Server-reported state (`PROVISIONING`, `RUNNING`, …). */
    state: string | undefined;
    /** VPC network. */
    network: string | undefined;
    /** Resource pool ids. */
    resourcePoolIds: string[];
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
    /** Time the resource first entered `RUNNING`. */
    startTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Vertex AI Persistent Resource — dedicated node pools for custom
 * training and Ray-on-Vertex workloads.
 *
 * Changing `persistentResourceId`, `location`, `network`,
 * `encryptionSpec`, or pool machine specs replaces the resource. Replica
 * counts, labels, and display name update in place.
 *
 * Provisioning typically takes several minutes.
 *
 * ### Creating a Persistent Resource
 * **Example:** Single n1-standard-4 pool
 * ```typescript
 * const pool = yield* GCP.AIPlatform.PersistentResource("Train", {
 *   resourcePools: [
 *     {
 *       id: "worker",
 *       replicaCount: "1",
 *       machineSpec: { machineType: "n1-standard-4" },
 *     },
 *   ],
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category AIPlatform
 */
export const PersistentResource = Resource<PersistentResource>(
  "GCP.AIPlatform.PersistentResource",
);

export class PersistentResourceNotResolved extends Data.TaggedError(
  "GCP.AIPlatform.PersistentResourceNotResolved",
)<{
  name: string;
}> {}

const resourceName = (project: string, location: string, id: string) =>
  `${locationParent(project, location)}/${COLLECTION}/${id}`;

const toPools = (
  pools: ResourcePool[] | undefined,
): aiplatform.GoogleCloudAiplatformV1ResourcePool[] =>
  (pools ?? [{}]).map((pool, index) => ({
    id: pool.id ?? `pool-${index}`,
    replicaCount: pool.replicaCount ?? DEFAULT_REPLICA_COUNT,
    machineSpec: {
      machineType: pool.machineSpec?.machineType ?? DEFAULT_MACHINE_TYPE,
      acceleratorType: pool.machineSpec?.acceleratorType,
      acceleratorCount: pool.machineSpec?.acceleratorCount,
      gpuPartitionSize: pool.machineSpec?.gpuPartitionSize,
      tpuTopology: pool.machineSpec?.tpuTopology,
    },
    diskSpec: pool.diskSpec,
    autoscalingSpec: pool.autoscalingSpec,
  }));

const machineKey = (pools: ResourcePool[] | undefined) =>
  JSON.stringify(
    toPools(pools).map((pool) => ({
      id: pool.id,
      machineSpec: pool.machineSpec,
    })),
  );

const toAttrs = (
  resource: aiplatform.GoogleCloudAiplatformV1PersistentResource,
  project: string,
) => {
  const name = resource.name ?? "";
  const parsed = parseResourceName(name, COLLECTION);
  return {
    name,
    persistentResourceId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    displayName: resource.displayName,
    labels: userLabels(resource.labels),
    state: resource.state,
    network: resource.network,
    resourcePoolIds: (resource.resourcePools ?? []).map(
      (pool) => pool.id ?? "",
    ),
    createTime: resource.createTime,
    updateTime: resource.updateTime,
    startTime: resource.startTime,
  };
};

const getByName = (name: string) =>
  aiplatform
    .getProjectsLocationsPersistentResources({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const waitUntilExists = (name: string) =>
  getByName(name).pipe(
    Effect.filterOrFail(
      (
        resource,
      ): resource is aiplatform.GoogleCloudAiplatformV1PersistentResource =>
        resource !== undefined,
      () => new AiPlatformNotResolved({ name }),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.AIPlatform.NotResolved",
      times: 8,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

const waitUntilGone = (name: string) =>
  getByName(name).pipe(
    Effect.filterOrFail(
      (resource) => resource === undefined,
      () => new AiPlatformStillExists({ name }),
    ),
    Effect.asVoid,
    Effect.retry({
      while: (error) => error._tag === "GCP.AIPlatform.StillExists",
      times: 10,
      schedule: Schedule.spaced("8 seconds"),
    }),
  );

export const PersistentResourceProvider = () =>
  Provider.succeed(PersistentResource, {
    stables: [
      "name",
      "persistentResourceId",
      "project",
      "location",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId =
        olds?.persistentResourceId ?? output?.persistentResourceId;
      const nextId = news.persistentResourceId ?? previousId;
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
      );
      const nextLocation = normalizeLocation(news.location ?? output?.location);
      const networkChanged =
        (news.network ?? olds?.network ?? "") !== (olds?.network ?? "");
      const machineChanged =
        olds !== undefined &&
        machineKey(news.resourcePools) !== machineKey(olds.resourcePools);
      const replace =
        (previousId !== undefined &&
          nextId !== undefined &&
          nextId !== previousId) ||
        previousLocation !== nextLocation ||
        (olds !== undefined && networkChanged) ||
        machineChanged;
      if (!replace) return undefined;
      return {
        action: "replace" as const,
        deleteFirst:
          previousLocation === nextLocation &&
          previousId !== undefined &&
          nextId === previousId,
      };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const resourceId = yield* toPhysicalId(
        id,
        olds?.persistentResourceId,
        output?.persistentResourceId,
      );
      const location = normalizeLocation(olds?.location ?? output?.location);
      const name =
        output?.name ?? resourceName(env.project, location, resourceId);
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
        const pages = yield* collectPages(
          aiplatform.listProjectsLocationsPersistentResources.pages({
            parent: locationParent(env.project, DEFAULT_LOCATION),
            pageSize: 100,
          }),
        ).pipe(
          Effect.catchTag("NotFound", () => Effect.succeed([])),
          Effect.catchTag("Forbidden", () => Effect.succeed([])),
        );
        return pages.flatMap((page) =>
          (page.persistentResources ?? [])
            .filter((resource) =>
              Object.keys(resource.labels ?? {}).some((key) =>
                key.startsWith("alchemy-"),
              ),
            )
            .map((resource) => toAttrs(resource, env.project)),
        );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const resourceId = yield* toPhysicalId(
        id,
        news.persistentResourceId,
        output?.persistentResourceId,
      );
      const location = normalizeLocation(news.location ?? output?.location);
      const name = resourceName(env.project, location, resourceId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const displayName = news.displayName ?? resourceId;
      const resourcePools = toPools(news.resourcePools);
      const resourceRuntimeSpec =
        news.raySpec || news.serviceAccountSpec
          ? {
              raySpec: news.raySpec
                ? {
                    imageUri: news.raySpec.imageUri,
                    resourcePoolImages: news.raySpec.resourcePoolImages,
                    headNodeResourcePoolId: news.raySpec.headNodeResourcePoolId,
                    rayLogsSpec: news.raySpec.rayLogsDisabled
                      ? { disabled: true }
                      : undefined,
                    rayMetricSpec: news.raySpec.rayMetricsDisabled
                      ? { disabled: true }
                      : undefined,
                  }
                : undefined,
              serviceAccountSpec: news.serviceAccountSpec,
            }
          : undefined;

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* aiplatform
          .createProjectsLocationsPersistentResources({
            parent: locationParent(env.project, location),
            persistentResourceId: resourceId,
            body: {
              displayName,
              labels: desiredLabels,
              resourcePools,
              network: news.network,
              reservedIpRanges: news.reservedIpRanges,
              encryptionSpec: news.encryptionSpec,
              resourceRuntimeSpec,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          yield* waitForOperation(created, { alreadyExistsOk: true });
        }
        const createdName =
          resourceNameFromOperation(created ?? {}) ?? output?.name ?? name;
        current = yield* waitUntilExists(createdName);
      }

      if (current === undefined) {
        return yield* new PersistentResourceNotResolved({ name });
      }

      const observedName = current.name ?? name;
      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const displayChanged = (current.displayName ?? "") !== displayName;
      const poolsChanged = !jsonEqual(current.resourcePools, resourcePools);

      if (labelsChanged || displayChanged || poolsChanged) {
        const updateMask = [
          labelsChanged ? "labels" : undefined,
          displayChanged ? "display_name" : undefined,
          poolsChanged ? "resource_pools" : undefined,
        ].filter((field): field is string => field !== undefined);
        const patched =
          yield* aiplatform.patchProjectsLocationsPersistentResources({
            name: observedName,
            updateMask: updateMask.join(","),
            body: {
              name: observedName,
              displayName,
              labels: desiredLabels,
              resourcePools,
            },
          });
        yield* waitForOperation(patched);
        current = yield* getByName(observedName);
      }

      if (current === undefined) {
        return yield* new PersistentResourceNotResolved({ name: observedName });
      }
      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* aiplatform
        .deleteProjectsLocationsPersistentResources({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
      if (operation !== undefined) {
        yield* waitForOperation(operation, { notFoundOk: true });
      }
      yield* waitUntilGone(output.name);
    }),
  });
