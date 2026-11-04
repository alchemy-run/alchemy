import * as datafusion from "@distilled.cloud/gcp/datafusion_v1";
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

/** Instance ids: a lowercase letter, then lowercase letters, digits and hyphens, "maximum 30 characters". */
const MAX_INSTANCE_ID_LENGTH = 30;

export type InstanceProps = {
  /**
   * Instance id. If omitted, a unique id is generated. Immutable — changing
   * it replaces the instance.
   */
  instanceId?: string;
  /**
   * Region. Immutable — changing it replaces the instance.
   * @default the stack's GCP region
   */
  location?: string;
  /**
   * Edition: `DEVELOPER` (one node, no SLA), `BASIC` or `ENTERPRISE`.
   * Immutable — changing it replaces the instance.
   * @default "DEVELOPER"
   */
  type?: "DEVELOPER" | "BASIC" | "ENTERPRISE";
  /** Display name. Immutable — changing it replaces the instance. */
  displayName?: string;
  /** Description. Immutable — changing it replaces the instance. */
  description?: string;
  /** Data Fusion version, e.g. `6.10.1`. Immutable here — changing it replaces the instance. */
  version?: string;
  /**
   * Reach the instance over private IP only. Immutable — changing it
   * replaces the instance.
   * @default false
   */
  privateInstance?: boolean;
  /** Network settings for a private instance. Immutable — changing them replaces the instance. */
  networkConfig?: datafusion.NetworkConfig;
  /**
   * Send pipeline logs to Cloud Logging. Updates in place.
   * @default false
   */
  enableStackdriverLogging?: boolean;
  /**
   * Send pipeline metrics to Cloud Monitoring. Updates in place.
   * @default false
   */
  enableStackdriverMonitoring?: boolean;
  /**
   * Role-based access control on namespaces (Enterprise only). Updates in place.
   * @default false
   */
  enableRbac?: boolean;
  /** Service account the instance's Dataproc clusters run as. Immutable — changing it replaces the instance. */
  dataprocServiceAccount?: string;
  /** User labels. Alchemy ownership labels are merged in automatically. */
  labels?: Record<string, string>;
};

export type Instance = Resource<
  "GCP.DataFusion.Instance",
  InstanceProps,
  {
    /** Full name `projects/{project}/locations/{location}/instances/{instance}`. */
    name: string;
    /** Instance id. */
    instanceId: string;
    /** Project id. */
    project: string;
    /** Region. */
    location: string;
    /** The UI endpoint (`https://…datafusion.googleusercontent.com`). */
    serviceEndpoint: string | undefined;
    /** The CDAP REST endpoint pipelines are deployed through. */
    apiEndpoint: string | undefined;
    /** The service account Data Fusion acts as in your project. */
    serviceAccount: string | undefined;
    /** Data Fusion version. */
    version: string | undefined;
    /** `CREATING`, `ACTIVE`, `UPGRADING`, … */
    state: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
  },
  never,
  Providers
>;

/**
 * A Cloud Data Fusion instance: a managed CDAP environment for building and
 * running data pipelines, which runs them on Dataproc clusters it creates.
 *
 * Labels, logging, monitoring and RBAC update in place; the edition,
 * version, network and service accounts are fixed at create. An instance
 * takes 15–25 minutes to provision; a project's first instances can take
 * a few attempts while Data Fusion sets up its tenant project.
 *
 * ### Creating an Instance
 * **Example:** A developer instance
 * ```typescript
 * const fusion = yield* GCP.DataFusion.Instance("Pipelines", {
 *   location: "us-central1",
 *   type: "DEVELOPER",
 * });
 * ```
 *
 * **Example:** A basic instance that logs to Cloud Logging
 * ```typescript
 * const fusion = yield* GCP.DataFusion.Instance("Etl", {
 *   type: "BASIC",
 *   enableStackdriverLogging: true,
 *   enableStackdriverMonitoring: true,
 *   labels: { team: "data" },
 * });
 * ```
 *
 * @resource
 * @category Cloud Data Fusion
 */
export const Instance = Resource<Instance>("GCP.DataFusion.Instance");

export class InstanceNotResolved extends Data.TaggedError("GCP.DataFusion.InstanceNotResolved")<{
  resourceName: string;
}> {}

export class InstanceStillExists extends Data.TaggedError("GCP.DataFusion.InstanceStillExists")<{
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
    return (generated || "fusion").slice(0, MAX_INSTANCE_ID_LENGTH).replace(/-+$/, "");
  });

const getByName = (name: string) =>
  datafusion
    .getProjectsLocationsInstances({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.undefined));

const toAttrs = (instance: datafusion.Instance, project: string): Instance["Attributes"] => {
  const name = instance.name ?? "";
  const parts = name.split("/");
  return {
    name,
    instanceId: lastSegment(name),
    project: parts[1] ?? project,
    location: parts[3] ?? "",
    serviceEndpoint: instance.serviceEndpoint,
    apiEndpoint: instance.apiEndpoint,
    serviceAccount: instance.serviceAccount,
    version: instance.version,
    state: instance.state,
    labels: stripInternalLabels(tagRecord(instance.labels)),
  };
};

const sameJson = (left: unknown, right: unknown) =>
  JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

const waitFor = (operation: datafusion.Operation) =>
  waitForOperation(operation, (name) => datafusion.getProjectsLocationsOperations({ name }), {
    budget: "45 minutes",
    interval: "15 seconds",
  });

export const InstanceProvider = () =>
  Provider.succeed(Instance, {
    stables: ["name", "instanceId", "project", "location", "serviceAccount"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previous = output?.location ?? olds?.location;
      if (previous !== undefined && previous !== (news.location ?? env.region)) {
        return { action: "replace" as const };
      }
      if (olds === undefined) return undefined;
      const fixedChanged =
        (news.instanceId !== undefined && news.instanceId !== olds.instanceId) ||
        (news.type ?? "DEVELOPER") !== (olds.type ?? "DEVELOPER") ||
        (news.displayName ?? "") !== (olds.displayName ?? "") ||
        (news.description ?? "") !== (olds.description ?? "") ||
        news.version !== olds.version ||
        (news.privateInstance ?? false) !== (olds.privateInstance ?? false) ||
        !sameJson(news.networkConfig, olds.networkConfig) ||
        news.dataprocServiceAccount !== olds.dataprocServiceAccount;
      return fixedChanged ? { action: "replace" as const } : undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const location = output?.location ?? olds?.location ?? env.region;
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
        return yield* datafusion.listProjectsLocationsInstances
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
      const location = news.location ?? output?.location ?? env.region;
      const instanceId = yield* toInstanceId(id, news.instanceId, output?.instanceId);
      const name = resourceName(env.project, location, instanceId);
      const desiredLabels = { ...toLabels(news.labels), ...(yield* createInternalLabels(id)) };

      // Observe
      let current = yield* getByName(output?.name ?? name);

      // Ensure
      if (current === undefined) {
        const create = datafusion
          .createProjectsLocationsInstances({
            parent: `projects/${env.project}/locations/${location}`,
            instanceId,
            body: {
              type: news.type ?? "DEVELOPER",
              displayName: news.displayName,
              description: news.description,
              version: news.version,
              privateInstance: news.privateInstance,
              networkConfig: news.networkConfig,
              enableStackdriverLogging: news.enableStackdriverLogging,
              enableStackdriverMonitoring: news.enableStackdriverMonitoring,
              enableRbac: news.enableRbac,
              dataprocServiceAccount: news.dataprocServiceAccount,
              labels: desiredLabels,
            },
          })
          .pipe(
            Effect.catchTag("Conflict", () => Effect.undefined),
            Effect.flatMap((operation) =>
              operation === undefined ? Effect.void : waitFor(operation),
            ),
          );
        // A project's first instances can fail while Data Fusion sets up its
        // tenant project (code 10 "Failed to perform tenant project creation");
        // a later attempt succeeds.
        yield* create.pipe(
          Effect.retry({
            while: (error) =>
              error._tag === "GCP.OperationFailed" &&
              error.message.includes("Failed to perform tenant project creation"),
            times: 8,
            schedule: Schedule.spaced("30 seconds"),
          }),
        );
        current = yield* getByName(name);
      }
      if (current === undefined) {
        return yield* new InstanceNotResolved({ resourceName: name });
      }

      // Sync the fields Data Fusion updates in place against the live instance.
      const { upsert, removed } = diffLabels(tagRecord(current.labels), desiredLabels);
      const mask = [
        (upsert.length > 0 || removed.length > 0) && "labels",
        (current.enableStackdriverLogging ?? false) !== (news.enableStackdriverLogging ?? false) &&
          "enable_stackdriver_logging",
        (current.enableStackdriverMonitoring ?? false) !==
          (news.enableStackdriverMonitoring ?? false) && "enable_stackdriver_monitoring",
        (current.enableRbac ?? false) !== (news.enableRbac ?? false) && "enable_rbac",
      ].filter((field): field is string => typeof field === "string");
      if (mask.length > 0) {
        const operation = yield* datafusion.patchProjectsLocationsInstances({
          name: current.name ?? name,
          updateMask: mask.join(","),
          body: {
            labels: desiredLabels,
            enableStackdriverLogging: news.enableStackdriverLogging ?? false,
            enableStackdriverMonitoring: news.enableStackdriverMonitoring ?? false,
            enableRbac: news.enableRbac ?? false,
          },
        });
        yield* waitFor(operation);
        current = (yield* getByName(current.name ?? name)) ?? current;
      }
      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.name) return;
      const operation = yield* datafusion
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
          while: (error) => error._tag === "GCP.DataFusion.InstanceStillExists",
          times: 30,
          schedule: Schedule.spaced("10 seconds"),
        }),
      );
    }),
  });
