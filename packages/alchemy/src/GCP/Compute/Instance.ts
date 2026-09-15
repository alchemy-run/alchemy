import * as compute from "@distilled.cloud/gcp/compute_v1";
import { waitZoneOperations } from "./operations.ts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
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

export type InstanceProps = {
  /**
   * Instance name. If omitted, a unique RFC1035 name is generated from the
   * stack, stage, and logical id. 1-63 characters, lowercase letter first.
   */
  instanceName?: string;
  /**
   * Zone to create the instance in (e.g. `us-central1-a`). Immutable —
   * changing it replaces the instance.
   * @default "us-central1-a"
   */
  zone?: string;
  /**
   * Machine type short name (`e2-micro`) or partial/full URL. Immutable —
   * changing it replaces the instance.
   * @default "e2-micro"
   */
  machineType?: string;
  /**
   * Optional description.
   */
  description?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
  /**
   * Network tags used by VPC firewall rules.
   */
  tags?: string[];
  /**
   * Instance metadata key/value pairs (replaces the instance metadata set).
   */
  metadata?: Record<string, string>;
  /**
   * Source image for the boot disk. Immutable — changing it replaces the
   * instance.
   * @default "projects/debian-cloud/global/images/family/debian-12"
   */
  sourceImage?: string;
  /**
   * Boot disk size in GB.
   * @default 10
   */
  diskSizeGb?: number;
  /**
   * VPC network URL or partial URL.
   * @default "global/networks/default"
   */
  network?: string;
  /**
   * Optional subnetwork URL or partial URL.
   */
  subnetwork?: string;
  /**
   * Attach an ephemeral public IPv4 address.
   * @default false
   */
  associatePublicIp?: boolean;
  /**
   * Create a preemptible VM. Immutable — changing it replaces the instance.
   * @default false
   */
  preemptible?: boolean;
  /**
   * Automatically restart the VM if Compute Engine terminates it.
   * Ignored (forced off) when `preemptible` is true.
   * @default true
   */
  automaticRestart?: boolean;
  /**
   * Allow packets with non-matching source/destination IPs (IP forwarding).
   * @default false
   */
  canIpForward?: boolean;
  /**
   * Protect the instance from accidental deletion.
   * @default false
   */
  deletionProtection?: boolean;
};

export type Instance = Resource<
  "GCP.Compute.Instance",
  InstanceProps,
  {
    /** Instance name (RFC1035). */
    instanceName: string;
    /** Server-assigned numeric instance id. */
    instanceId: string;
    /** Project id. */
    project: string;
    /** Zone short name (e.g. `us-central1-a`). */
    zone: string;
    /** Machine type short name (e.g. `e2-micro`). */
    machineType: string;
    /** Current instance status (`RUNNING`, `TERMINATED`, …). */
    status: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Network tags. */
    tags: string[];
    /** Instance metadata key/value pairs. */
    metadata: Record<string, string>;
    /** Whether deletion protection is enabled. */
    deletionProtection: boolean;
    /** Whether IP forwarding is enabled. */
    canIpForward: boolean;
    /** Primary internal IPv4. */
    networkIP: string | undefined;
    /** Ephemeral or reserved public IPv4, if any. */
    natIP: string | undefined;
    /** Compute Engine self-link. */
    selfLink: string | undefined;
    /** RFC3339 creation timestamp. */
    creationTimestamp: string | undefined;
    /** CPU platform reported by Compute Engine. */
    cpuPlatform: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Google Compute Engine VM instance.
 *
 * ### Creating an Instance
 * **Example:** Generated name
 * ```typescript
 * const vm = yield* GCP.Compute.Instance("web", {
 *   zone: "us-central1-a",
 *   machineType: "e2-micro",
 * });
 * ```
 *
 * **Example:** Explicit name, labels, and metadata
 * ```typescript
 * const vm = yield* GCP.Compute.Instance("web", {
 *   instanceName: "web-1",
 *   zone: "us-central1-a",
 *   machineType: "e2-micro",
 *   sourceImage: "projects/debian-cloud/global/images/family/debian-12",
 *   labels: { env: "prod" },
 *   tags: ["http-server"],
 *   metadata: { "enable-oslogin": "TRUE" },
 * });
 * ```
 *
 * ### Starting and Stopping
 * **Example:** Start a bound instance
 * ```typescript
 * const start = yield* GCP.Compute.StartInstance(vm);
 * yield* start();
 * ```
 *
 * @resource
 * @product GCP
 * @category Compute
 */
export const Instance = Resource<Instance>("GCP.Compute.Instance");

export class InstanceNotResolved extends Data.TaggedError(
  "GCP.Compute.InstanceNotResolved",
)<{
  instanceName: string;
  zone: string;
}> {}

export class InstanceOperationFailed extends Data.TaggedError(
  "GCP.Compute.InstanceOperationFailed",
)<{
  operation: string;
  code: string;
  message: string;
}> {}

export class InstanceStillExists extends Data.TaggedError(
  "GCP.Compute.InstanceStillExists",
)<{
  instanceName: string;
  zone: string;
  status: string;
}> {}

const DEFAULT_ZONE = "us-central1-a";
const DEFAULT_MACHINE_TYPE = "e2-micro";
const DEFAULT_SOURCE_IMAGE =
  "projects/debian-cloud/global/images/family/debian-12";
const DEFAULT_NETWORK = "global/networks/default";
const DEFAULT_DISK_SIZE_GB = 10;

const lastSegment = (value: string | undefined): string => {
  if (value === undefined || value.length === 0) return "";
  const parts = value.split("/");
  return parts[parts.length - 1] ?? value;
};

const rfc1035 = (name: string): string => {
  let next = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!/^[a-z]/.test(next)) next = `n${next}`;
  next = next.slice(0, 63).replace(/-+$/g, "");
  return next.length > 0 ? next : "instance";
};

const machineTypeUrl = (zone: string, machineType: string): string =>
  machineType.includes("/")
    ? machineType
    : `zones/${zone}/machineTypes/${machineType}`;

const userLabels = (
  labels: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalLabels(tagRecord(labels));

const metadataRecord = (
  metadata: compute.Metadata | undefined,
): Record<string, string> =>
  Object.fromEntries(
    (metadata?.items ?? [])
      .filter((item) => item.key !== undefined)
      .map((item) => [item.key!, item.value ?? ""]),
  );

const sameRecord = (
  left: Record<string, string>,
  right: Record<string, string>,
): boolean => {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    if (left[key] !== right[key]) return false;
  }
  return true;
};

const sameTags = (left: string[], right: string[]): boolean => {
  if (left.length !== right.length) return false;
  const a = [...left].sort();
  const b = [...right].sort();
  return a.every((value, index) => value === b[index]);
};

const toName = (id: string, name: string | undefined, existing?: string) =>
  Effect.gen(function* () {
    return (
      name ??
      existing ??
      rfc1035(
        yield* createPhysicalName({
          id,
          maxLength: 63,
          lowercase: true,
        }),
      )
    );
  });

const toAttrs = (instance: compute.Instance, project: string) => {
  const nic = instance.networkInterfaces?.[0];
  return {
    instanceName: instance.name ?? "",
    instanceId: instance.id ?? "",
    project,
    zone: lastSegment(instance.zone),
    machineType: lastSegment(instance.machineType),
    status: instance.status,
    labels: userLabels(instance.labels),
    tags: [...(instance.tags?.items ?? [])],
    metadata: metadataRecord(instance.metadata),
    deletionProtection: instance.deletionProtection === true,
    canIpForward: instance.canIpForward === true,
    networkIP: nic?.networkIP,
    natIP: nic?.accessConfigs?.[0]?.natIP,
    selfLink: instance.selfLink,
    creationTimestamp: instance.creationTimestamp,
    cpuPlatform: instance.cpuPlatform,
  };
};

const getByName = (project: string, zone: string, instance: string) =>
  compute
    .getInstances({ project, zone, instance })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const waitUntilGone = (project: string, zone: string, instanceName: string) =>
  getByName(project, zone, instanceName).pipe(
    Effect.flatMap((instance) =>
      instance === undefined
        ? Effect.void
        : Effect.fail(
            new InstanceStillExists({
              instanceName,
              zone,
              status: instance.status ?? "UNKNOWN",
            }),
          ),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.Compute.InstanceStillExists",
      times: 18,
      schedule: Schedule.spaced("3 seconds"),
    }),
  );

const operationCodes = (operation: compute.Operation) =>
  (operation.error?.errors ?? []).map((item) => item.code ?? "");

const isAlreadyExistsCode = (code: string) =>
  code === "alreadyExists" ||
  code === "RESOURCE_ALREADY_EXISTS" ||
  code === "ALREADY_EXISTS";

const isNotFoundCode = (code: string) =>
  code === "notFound" ||
  code === "RESOURCE_NOT_FOUND" ||
  code === "RESOURCE_NOT_FOUND_BY_NAME";

const waitZoneOperation = (
  project: string,
  zone: string,
  operation: compute.Operation,
) =>
  Effect.gen(function* () {
    const operationName = lastSegment(
      operation.name ?? operation.id ?? operation.selfLink,
    );
    if (operationName.length === 0) {
      return yield* new InstanceOperationFailed({
        operation: "",
        code: "UNKNOWN",
        message: "zone operation is missing a name",
      });
    }

    let current = operation;
    if (current.status !== "DONE") {
      current = yield* waitZoneOperations({
        project,
        zone,
        operation: operationName,
      }).pipe(
        Effect.retry({
          while: (error) => error._tag === "NotFound",
          times: 5,
          schedule: Schedule.exponential("250 millis"),
        }),
      );
    }
    if (current.status !== "DONE") {
      current = yield* waitZoneOperations({
        project,
        zone,
        operation: operationName,
      }).pipe(
        Effect.repeat({
          schedule: Schedule.exponential("500 millis"),
          until: (next) => next.status === "DONE",
          times: 18,
        }),
      );
    }

    const errors = current.error?.errors ?? [];
    const codes = operationCodes(current);
    if (
      codes.some(isAlreadyExistsCode) ||
      current.httpErrorStatusCode === 409
    ) {
      return current;
    }
    if (codes.some(isNotFoundCode) || current.httpErrorStatusCode === 404) {
      return current;
    }
    if (errors.length > 0 || current.status !== "DONE") {
      return yield* new InstanceOperationFailed({
        operation: operationName,
        code: codes[0] ?? String(current.httpErrorStatusCode ?? "UNKNOWN"),
        message:
          errors
            .map((item) => item.message ?? item.code ?? "unknown")
            .join("; ") ||
          current.httpErrorMessage ||
          "Compute operation failed",
      });
    }
    return current;
  });

const applyZoneOp = <E, R>(
  project: string,
  zone: string,
  start: Effect.Effect<compute.Operation, E, R>,
) =>
  Effect.gen(function* () {
    const op = yield* start;
    return yield* waitZoneOperation(project, zone, op);
  });

const insertBody = (
  news: InstanceProps,
  instanceName: string,
  zone: string,
  desiredLabels: Record<string, string>,
): compute.Instance => {
  const preemptible = news.preemptible === true;
  const metadata = news.metadata
    ? {
        items: Object.entries(news.metadata).map(([key, value]) => ({
          key,
          value,
        })),
      }
    : undefined;
  return {
    name: instanceName,
    machineType: machineTypeUrl(zone, news.machineType ?? DEFAULT_MACHINE_TYPE),
    description: news.description,
    labels: desiredLabels,
    tags: news.tags ? { items: news.tags } : undefined,
    metadata,
    canIpForward: news.canIpForward === true,
    deletionProtection: news.deletionProtection === true,
    scheduling: preemptible
      ? {
          preemptible: true,
          automaticRestart: false,
          onHostMaintenance: "TERMINATE",
        }
      : {
          preemptible: false,
          automaticRestart: news.automaticRestart !== false,
        },
    disks: [
      {
        boot: true,
        autoDelete: true,
        type: "PERSISTENT",
        initializeParams: {
          sourceImage: news.sourceImage ?? DEFAULT_SOURCE_IMAGE,
          diskSizeGb: String(news.diskSizeGb ?? DEFAULT_DISK_SIZE_GB),
        },
      },
    ],
    networkInterfaces: [
      {
        network: news.network ?? DEFAULT_NETWORK,
        subnetwork: news.subnetwork,
        accessConfigs:
          news.associatePublicIp === true
            ? [{ type: "ONE_TO_ONE_NAT", name: "External NAT" }]
            : [],
      },
    ],
  };
};

export const InstanceProvider = () =>
  Provider.succeed(Instance, {
    stables: [
      "instanceName",
      "instanceId",
      "project",
      "zone",
      "selfLink",
      "creationTimestamp",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousZone = olds?.zone ?? output?.zone ?? DEFAULT_ZONE;
      const nextZone = news.zone ?? DEFAULT_ZONE;
      if (lastSegment(previousZone) !== lastSegment(nextZone)) {
        return { action: "replace" as const };
      }
      const previousName = olds?.instanceName ?? output?.instanceName;
      const nextName = news.instanceName ?? previousName;
      if (
        previousName !== undefined &&
        nextName !== undefined &&
        previousName !== nextName
      ) {
        return { action: "replace" as const, deleteFirst: true };
      }
      const previousType = lastSegment(
        olds?.machineType ?? DEFAULT_MACHINE_TYPE,
      );
      const nextType = lastSegment(news.machineType ?? DEFAULT_MACHINE_TYPE);
      if (olds !== undefined && previousType !== nextType) {
        return { action: "replace" as const, deleteFirst: true };
      }
      if (
        olds?.sourceImage !== undefined &&
        news.sourceImage !== undefined &&
        olds.sourceImage !== news.sourceImage
      ) {
        return { action: "replace" as const, deleteFirst: true };
      }
      if (
        olds !== undefined &&
        (olds.preemptible === true) !== (news.preemptible === true)
      ) {
        return { action: "replace" as const, deleteFirst: true };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const instanceName = yield* toName(
        id,
        olds?.instanceName,
        output?.instanceName,
      );
      const zone = lastSegment(olds?.zone ?? output?.zone ?? DEFAULT_ZONE);
      const existing = yield* getByName(env.project, zone, instanceName);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const pages = yield* compute.aggregatedListInstances
          .pages({
            project: env.project,
            filter: "labels.alchemy-id:*",
            returnPartialSuccess: true,
            maxResults: 500,
          })
          .pipe(Stream.runCollect);
        return Array.from(pages).flatMap((page) =>
          Object.values(page.items ?? {}).flatMap((scoped) =>
            (scoped?.instances ?? []).map((instance) =>
              toAttrs(instance, env.project),
            ),
          ),
        );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const zone = lastSegment(news.zone ?? output?.zone ?? DEFAULT_ZONE);
      const instanceName = yield* toName(
        id,
        news.instanceName,
        output?.instanceName,
      );
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };

      let current = yield* getByName(env.project, zone, instanceName);

      if (current === undefined) {
        yield* applyZoneOp(
          env.project,
          zone,
          compute.insertInstances({
            project: env.project,
            zone,
            body: insertBody(news, instanceName, zone, desiredLabels),
          }),
        ).pipe(Effect.catchTag("Conflict", () => Effect.void));
        current = yield* getByName(env.project, zone, instanceName).pipe(
          Effect.flatMap((existing) =>
            existing !== undefined
              ? Effect.succeed(existing)
              : Effect.fail(new InstanceNotResolved({ instanceName, zone })),
          ),
          Effect.retry({
            while: (error) => error._tag === "GCP.Compute.InstanceNotResolved",
            schedule: Schedule.spaced("2 seconds"),
            times: 8,
          }),
        );
      }

      if (current === undefined) {
        return yield* new InstanceNotResolved({ instanceName, zone });
      }

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      if (upsert.length > 0 || removed.length > 0) {
        yield* applyZoneOp(
          env.project,
          zone,
          compute.setLabelsInstances({
            project: env.project,
            zone,
            instance: instanceName,
            body: {
              labels: desiredLabels,
              labelFingerprint: current.labelFingerprint,
            },
          }),
        );
        current =
          (yield* getByName(env.project, zone, instanceName)) ?? current;
      }

      if (news.tags !== undefined) {
        const observedTags = [...(current.tags?.items ?? [])];
        if (!sameTags(observedTags, news.tags)) {
          yield* applyZoneOp(
            env.project,
            zone,
            compute.setTagsInstances({
              project: env.project,
              zone,
              instance: instanceName,
              body: {
                items: news.tags,
                fingerprint: current.tags?.fingerprint,
              },
            }),
          );
          current =
            (yield* getByName(env.project, zone, instanceName)) ?? current;
        }
      }

      if (news.metadata !== undefined) {
        const observedMetadata = metadataRecord(current.metadata);
        if (!sameRecord(observedMetadata, news.metadata)) {
          yield* applyZoneOp(
            env.project,
            zone,
            compute.setMetadataInstances({
              project: env.project,
              zone,
              instance: instanceName,
              body: {
                fingerprint: current.metadata?.fingerprint,
                items: Object.entries(news.metadata).map(([key, value]) => ({
                  key,
                  value,
                })),
              },
            }),
          );
          current =
            (yield* getByName(env.project, zone, instanceName)) ?? current;
        }
      }

      const desiredProtection = news.deletionProtection === true;
      if ((current.deletionProtection === true) !== desiredProtection) {
        yield* applyZoneOp(
          env.project,
          zone,
          compute.setDeletionProtectionInstances({
            project: env.project,
            zone,
            resource: instanceName,
            deletionProtection: desiredProtection,
          }),
        );
        current =
          (yield* getByName(env.project, zone, instanceName)) ?? current;
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output, force }) {
      const env = yield* GcpEnvironment.current;
      const zone = lastSegment(output.zone);
      const instance = output.instanceName;
      if (output.deletionProtection === true || force === true) {
        yield* applyZoneOp(
          env.project,
          zone,
          compute.setDeletionProtectionInstances({
            project: env.project,
            zone,
            resource: instance,
            deletionProtection: false,
          }),
        ).pipe(Effect.catchTag("NotFound", () => Effect.void));
      }
      yield* applyZoneOp(
        env.project,
        zone,
        compute.deleteInstances({
          project: env.project,
          zone,
          instance,
        }),
      ).pipe(
        Effect.retry({
          while: (error) =>
            error._tag === "Conflict" ||
            error._tag === "GCP.Compute.InstanceOperationFailed" ||
            error._tag === "GCP.Compute.OperationPending",
          times: 8,
          schedule: Schedule.spaced("3 seconds"),
        }),
        Effect.catchTag("NotFound", () => Effect.void),
        Effect.catchTag("GCP.Compute.OperationPending", () => Effect.void),
      );
      yield* waitUntilGone(env.project, zone, instance);
    }),
  });
