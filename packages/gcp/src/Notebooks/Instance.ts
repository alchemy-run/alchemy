import * as notebooks from "@distilled.cloud/gcp/notebooks_v2";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import { tagRecord } from "alchemy/Tags";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { GcpEnvironment } from "../Environment.ts";
import {
  createInternalLabels,
  diffLabels,
  hasAlchemyLabels,
  stripInternalLabels,
  toLabels,
} from "../Labels.ts";
import { waitForOperation } from "../Operation.ts";
import type { Providers } from "../Providers.ts";

/** "a lowercase letter followed by up to 47 lowercase letters, numbers, or hyphens" */
const MAX_INSTANCE_ID_LENGTH = 48;
const DEFAULT_MACHINE_TYPE = "e2-standard-2";

export type InstanceProps = {
  /**
   * Instance id. If omitted, a unique id is generated. Immutable — changing
   * it replaces the instance.
   */
  instanceId?: string;
  /**
   * Zone the instance runs in. Immutable — changing it replaces the instance.
   * @default `${region}-a` for the stack's GCP region
   */
  location?: string;
  /**
   * Compute Engine machine type. Updates in place (Workbench stops and
   * restarts the VM to apply it).
   * @default "e2-standard-2"
   */
  machineType?: string;
  /**
   * Boot disk image. Immutable — changing it replaces the instance.
   * @default Workbench's current image
   */
  vmImage?: notebooks.VmImage;
  /** A custom container image the instance runs instead of a VM image. */
  containerImage?: notebooks.ContainerImage;
  /** Boot disk size and type. Immutable — changing it replaces the instance. */
  bootDisk?: notebooks.BootDisk;
  /** Network and subnet the instance attaches to. Immutable — changing them replaces the instance. */
  networkInterfaces?: notebooks.NetworkInterface[];
  /** The service account the VM runs as. Immutable — changing it replaces the instance. */
  serviceAccount?: string;
  /** Guest metadata. Updates in place. */
  metadata?: Record<string, string>;
  /**
   * Turn off the external IP. Workbench can only turn it off in place:
   * turning it back on replaces the instance.
   * @default false
   */
  disablePublicIp?: boolean;
  /**
   * Users who own the instance (single-user mode). Immutable — changing them
   * replaces the instance.
   */
  instanceOwners?: string[];
  /** User labels. Alchemy ownership labels are merged in automatically. */
  labels?: Record<string, string>;
};

export type Instance = Resource<
  "GCP.Notebooks.Instance",
  InstanceProps,
  {
    /** Full name `projects/{project}/locations/{zone}/instances/{instance}`. */
    name: string;
    /** Instance id. */
    instanceId: string;
    /** Project id. */
    project: string;
    /** Zone. */
    location: string;
    /** JupyterLab URL (`https://….notebooks.googleusercontent.com`). */
    proxyUri: string | undefined;
    /** `ACTIVE`, `STOPPED`, `PROVISIONING`, … */
    state: string | undefined;
    /** Machine type. */
    machineType: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
  },
  never,
  Providers
>;

/**
 * A Vertex AI Workbench instance: a Compute Engine VM running JupyterLab,
 * reached through the URL in `proxyUri`.
 *
 * Labels, metadata and machine type update in place; Workbench stops and
 * restarts the VM to change its machine type. The image, disks, network,
 * service account and owners are fixed at create.
 *
 * ### Creating an Instance
 * **Example:** A default Workbench instance
 * ```typescript
 * const notebook = yield* GCP.Notebooks.Instance("Lab", {
 *   location: "us-central1-a",
 * });
 * ```
 *
 * **Example:** A larger VM without an external IP
 * ```typescript
 * const notebook = yield* GCP.Notebooks.Instance("Training", {
 *   location: "us-central1-a",
 *   machineType: "n2-standard-8",
 *   bootDisk: { diskSizeGb: "200", diskType: "PD_SSD" },
 *   disablePublicIp: true,
 *   labels: { team: "ml" },
 * });
 * ```
 *
 * @resource
 * @category Vertex AI Workbench
 */
export const Instance = Resource<Instance>("GCP.Notebooks.Instance");

export class InstanceNotResolved extends Data.TaggedError("GCP.Notebooks.InstanceNotResolved")<{
  resourceName: string;
}> {}

export class InstanceStillExists extends Data.TaggedError("GCP.Notebooks.InstanceStillExists")<{
  resourceName: string;
}> {}

const lastSegment = (value: string) => value.replace(/\/+$/, "").split("/").pop() ?? value;

const resourceName = (project: string, location: string, instanceId: string) =>
  `projects/${project}/locations/${location}/instances/${instanceId}`;

const toInstanceId = (id: string, explicit: string | undefined, existing: string | undefined) =>
  Effect.gen(function* () {
    if (explicit !== undefined) return explicit;
    if (existing !== undefined) return existing;
    const generated = (yield* createPhysicalName({
      id,
      maxLength: MAX_INSTANCE_ID_LENGTH,
      lowercase: true,
    }))
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^[^a-z]+/, "");
    return (generated || "notebook").slice(0, MAX_INSTANCE_ID_LENGTH).replace(/-+$/, "");
  });

const getByName = (name: string) =>
  notebooks
    .getProjectsLocationsInstances({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.undefined));

const lastPath = (value: string | undefined) =>
  value === undefined ? undefined : lastSegment(value);

const toAttrs = (instance: notebooks.Instance, project: string): Instance["Attributes"] => {
  const name = instance.name ?? "";
  const parts = name.split("/");
  return {
    name,
    instanceId: lastSegment(name),
    project: parts[1] ?? project,
    location: parts[3] ?? "",
    proxyUri: instance.proxyUri,
    state: instance.state,
    machineType: lastPath(instance.gceSetup?.machineType),
    labels: stripInternalLabels(tagRecord(instance.labels)),
  };
};

const sameJson = (left: unknown, right: unknown) =>
  JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

const waitFor = (operation: notebooks.Operation) =>
  waitForOperation(operation, (name) => notebooks.getProjectsLocationsOperations({ name }), {
    budget: "20 minutes",
    interval: "10 seconds",
  });

const defaultZone = (region: string) => `${region}-a`;

export const InstanceProvider = () =>
  Provider.succeed(Instance, {
    stables: ["name", "instanceId", "project", "location"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousZone = output?.location ?? olds?.location;
      const nextZone = news.location ?? defaultZone(env.region);
      if (previousZone !== undefined && previousZone !== nextZone) {
        return { action: "replace" as const };
      }
      if (olds === undefined) return undefined;
      const fixedChanged =
        (news.instanceId !== undefined && news.instanceId !== olds.instanceId) ||
        !sameJson(news.vmImage, olds.vmImage) ||
        !sameJson(news.bootDisk, olds.bootDisk) ||
        !sameJson(news.networkInterfaces, olds.networkInterfaces) ||
        news.serviceAccount !== olds.serviceAccount ||
        !sameJson(news.instanceOwners, olds.instanceOwners) ||
        // Turning the external IP back on isn't an update Workbench accepts.
        (olds.disablePublicIp === true && news.disablePublicIp !== true);
      return fixedChanged ? { action: "replace" as const } : undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const location = output?.location ?? olds?.location ?? defaultZone(env.region);
      const instanceId = yield* toInstanceId(id, olds?.instanceId, output?.instanceId);
      const existing = yield* getByName(
        output?.name ?? resourceName(env.project, location, instanceId),
      );
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels))) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        return yield* notebooks.listProjectsLocationsInstances
          .pages({ parent: `projects/${env.project}/locations/-` })
          .pipe(
            Stream.flatMap((page) => Stream.fromIterable(page.instances ?? [])),
            Stream.filter((instance) =>
              Object.keys(instance.labels ?? {}).some((key) => key.startsWith("alchemy-")),
            ),
            Stream.map((instance) => toAttrs(instance, env.project)),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
          );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = news.location ?? output?.location ?? defaultZone(env.region);
      const instanceId = yield* toInstanceId(id, news.instanceId, output?.instanceId);
      const name = resourceName(env.project, location, instanceId);
      const desiredLabels = { ...toLabels(news.labels), ...(yield* createInternalLabels(id)) };
      const machineType = news.machineType ?? DEFAULT_MACHINE_TYPE;

      // Observe
      let current = yield* getByName(output?.name ?? name);

      // Ensure
      if (current === undefined) {
        const operation = yield* notebooks
          .createProjectsLocationsInstances({
            parent: `projects/${env.project}/locations/${location}`,
            instanceId,
            body: {
              labels: desiredLabels,
              instanceOwners: news.instanceOwners,
              gceSetup: {
                machineType,
                vmImage: news.vmImage,
                containerImage: news.containerImage,
                bootDisk: news.bootDisk,
                networkInterfaces: news.networkInterfaces,
                serviceAccounts: news.serviceAccount ? [{ email: news.serviceAccount }] : undefined,
                metadata: news.metadata,
                disablePublicIp: news.disablePublicIp,
              },
            },
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.undefined));
        if (operation !== undefined) yield* waitFor(operation);
        current = yield* getByName(name);
      }
      if (current === undefined) {
        return yield* new InstanceNotResolved({ resourceName: name });
      }

      // Sync the fields Workbench updates in place against the live instance.
      const { upsert, removed } = diffLabels(tagRecord(current.labels), desiredLabels);
      const observedMetadata = Object.fromEntries(
        Object.entries(current.gceSetup?.metadata ?? {}).filter(([key]) =>
          Object.hasOwn(news.metadata ?? {}, key),
        ),
      );
      const mask = [
        (upsert.length > 0 || removed.length > 0) && "labels",
        lastPath(current.gceSetup?.machineType) !== machineType && "gce_setup.machine_type",
        news.metadata !== undefined &&
          !sameJson(observedMetadata, news.metadata) &&
          "gce_setup.metadata",
        news.disablePublicIp === true &&
          current.gceSetup?.disablePublicIp !== true &&
          "gce_setup.disable_public_ip",
      ].filter((field): field is string => typeof field === "string");
      if (mask.length > 0) {
        const operation = yield* notebooks.patchProjectsLocationsInstances({
          name: current.name ?? name,
          updateMask: mask.join(","),
          body: {
            labels: desiredLabels,
            gceSetup: {
              machineType,
              metadata: { ...current.gceSetup?.metadata, ...news.metadata },
              disablePublicIp: news.disablePublicIp,
            },
          },
        });
        yield* waitFor(operation);
        current = (yield* getByName(current.name ?? name)) ?? current;
      }
      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.name) return;
      const operation = yield* notebooks
        .deleteProjectsLocationsInstances({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.undefined));
      if (operation !== undefined) {
        yield* waitFor(operation).pipe(Effect.catchTag("NotFound", () => Effect.void));
      }
      yield* getByName(output.name).pipe(
        Effect.filterOrFail(
          (instance) => instance === undefined,
          () => new InstanceStillExists({ resourceName: output.name }),
        ),
        Effect.retry({
          while: (error) => error._tag === "GCP.Notebooks.InstanceStillExists",
          times: 30,
          schedule: Schedule.spaced("10 seconds"),
        }),
      );
    }),
  });
