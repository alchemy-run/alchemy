import * as containerregistry from "@distilled.cloud/azure/containerregistry";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  desiredTags,
  ensureRegistered,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  createRegistryName,
  getRegistry,
  matchesObserved,
  normalizeLocation,
  sameName,
} from "./Common.ts";
import type { RegistryIdentity } from "./Registry.ts";

export interface TaskArgument {
  /** Argument (or value) name. */
  name: string;
  /** Argument value. */
  value: string;
  /** Whether the value is secret (hidden from run logs and reads). */
  isSecret?: boolean;
}

interface TaskStepCommon {
  /**
   * Source context: a Git URL, a blob SAS URL, or `/dev/null` for steps
   * that need no context.
   */
  contextPath?: string;
  /** Token (Git PAT or blob SAS) for a private context; never read back. */
  contextAccessToken?: string;
}

export interface DockerTaskStep extends TaskStepCommon {
  type: "Docker";
  /** Dockerfile path relative to the context. */
  dockerFilePath: string;
  /** Image names (`repo:tag`; `{{.Run.ID}}` is substituted per run). */
  imageNames?: string[];
  /** Push the built image to the registry. @default true */
  isPushEnabled?: boolean;
  /** Disable the build cache. @default false */
  noCache?: boolean;
  /** Target build stage. */
  target?: string;
  /** Build arguments. */
  arguments?: TaskArgument[];
}

export interface FileTaskStep extends TaskStepCommon {
  type: "FileTask";
  /** Multi-step task YAML path relative to the context. */
  taskFilePath: string;
  /** Values file path relative to the context. */
  valuesFilePath?: string;
  /** Values that override the values file. */
  values?: TaskArgument[];
}

export interface EncodedTaskStep extends TaskStepCommon {
  type: "EncodedTask";
  /** Base64-encoded multi-step task YAML. */
  encodedTaskContent: string;
  /** Base64-encoded values file. */
  encodedValuesContent?: string;
  /** Values that override the values file. */
  values?: TaskArgument[];
}

export type TaskStep = DockerTaskStep | FileTaskStep | EncodedTaskStep;

export interface TaskTimerTrigger {
  /** Trigger name. */
  name: string;
  /** CRON schedule (UTC), e.g. `0 3 * * *`. */
  schedule: string;
  /** @default "Enabled" */
  status?: "Enabled" | "Disabled";
}

export interface TaskBaseImageTrigger {
  /** Trigger name. */
  name: string;
  /** Which base-image updates trigger a run. */
  baseImageTriggerType: "All" | "Runtime";
  /** @default "Enabled" */
  status?: "Enabled" | "Disabled";
}

export interface TaskProps {
  /** Resource group of the registry. Changing it replaces the task. */
  resourceGroup: string;
  /** Registry that runs the task. Changing it replaces the task. */
  registry: string;
  /**
   * Task name: 5-50 letters, digits, hyphens, and underscores. If omitted, a
   * unique name is generated from the app, stage, and logical ID. Changing
   * it replaces the task.
   */
  name?: string;
  /**
   * Location of the task; must be the registry's location. Changing it
   * replaces the task.
   * @default the registry's location
   */
  location?: string;
  /** Platform the task runs on. */
  platform: {
    /** Operating system. */
    os: "Linux" | "Windows";
    /** CPU architecture. @default "amd64" */
    architecture?: "amd64" | "x86" | "arm";
    /** CPU variant (ARM only). */
    variant?: "v6" | "v7" | "v8";
  };
  /** What the task does: build an image, or run a multi-step task file. */
  step: TaskStep;
  /** Whether the task can run. @default "Enabled" */
  status?: "Enabled" | "Disabled";
  /** Run timeout in seconds (300-28800). @default 3600 */
  timeout?: number;
  /** CPU cores for the run agent. @default 2 */
  agentCpu?: number;
  /** Scheduled triggers. */
  timerTriggers?: TaskTimerTrigger[];
  /** Run when a base image of the built image is updated. */
  baseImageTrigger?: TaskBaseImageTrigger;
  /** Managed identity of the task (e.g. to push to other registries). */
  identity?: RegistryIdentity;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface Task extends Resource<
  "Azure.ContainerRegistry.Task",
  TaskProps,
  {
    /** Name of the task. */
    taskName: string;
    /** ARM resource ID of the task. */
    taskId: string;
    /** Registry that runs the task. */
    registry: string;
    /** Resource group of the registry. */
    resourceGroup: string;
    /** Location of the task. */
    location: string;
    /** Whether the task can run. */
    status: string;
    /** Principal ID of the task's system-assigned identity, if any. */
    principalId: string | undefined;
    /** Creation date (ISO 8601). */
    creationDate: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An ACR Task — a container image build or multi-step task that runs in
 * Azure on a schedule, on base-image updates, or on demand.
 *
 * ACR Tasks are not available on Azure free-trial / free-credit
 * subscriptions. Source-code (Git commit) triggers are not managed by this
 * resource.
 *
 * @see https://learn.microsoft.com/azure/container-registry/container-registry-tasks-overview
 *
 * ### Building Images
 * **Example:** Nightly Docker build from GitHub
 * ```typescript
 * const nightly = yield* Azure.ContainerRegistry.Task("nightly", {
 *   resourceGroup: group.resourceGroupName,
 *   registry: registry.registryName,
 *   platform: { os: "Linux" },
 *   step: {
 *     type: "Docker",
 *     contextPath: "https://github.com/Azure-Samples/acr-build-helloworld-node.git",
 *     dockerFilePath: "Dockerfile",
 *     imageNames: ["helloworld:{{.Run.ID}}"],
 *   },
 *   timerTriggers: [{ name: "nightly", schedule: "0 3 * * *" }],
 * });
 * ```
 *
 * ### Multi-step Tasks
 * **Example:** Inline (base64) task YAML
 * ```typescript
 * const purge = yield* Azure.ContainerRegistry.Task("purge", {
 *   resourceGroup: group.resourceGroupName,
 *   registry: registry.registryName,
 *   platform: { os: "Linux" },
 *   step: {
 *     type: "EncodedTask",
 *     encodedTaskContent: Buffer.from(
 *       "version: v1.1.0\nsteps:\n  - cmd: acr purge --filter 'app:.*' --ago 7d --untagged\n",
 *     ).toString("base64"),
 *   },
 *   timerTriggers: [{ name: "weekly", schedule: "0 1 * * Sun" }],
 * });
 * ```
 *
 * @resource
 */
export const Task = Resource<Task>("Azure.ContainerRegistry.Task");

const getTask = (
  subscriptionId: string,
  resourceGroupName: string,
  registryName: string,
  taskName: string,
) =>
  orUndefinedIfNotFound(
    containerregistry.GetTask({
      subscriptionId,
      resourceGroupName,
      registryName,
      taskName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  registry: string,
  name: string,
  task: containerregistry.GetTaskResponse,
): Task["Attributes"] => ({
  taskName: name,
  taskId: task.id ?? "",
  registry,
  resourceGroup,
  location: task.location,
  status: task.properties?.status ?? "Enabled",
  principalId: task.identity?.principalId,
  creationDate: task.properties?.creationDate,
  tags: userTags(task.tags),
});

/** The step as sent to ARM (`isSecret` values are never read back). */
const stepInput = (step: TaskStep) => ({ ...step });

/** The comparable part of the step (secrets and tokens are not returned). */
const comparableStep = (step: TaskStep) => {
  const { contextAccessToken: _, ...rest } = step;
  const strip = (args: TaskArgument[] | undefined) =>
    args?.some((a) => a.isSecret) ? undefined : args;
  if (rest.type === "Docker")
    return { ...rest, arguments: strip(rest.arguments) };
  return { ...rest, values: strip(rest.values) };
};

const desiredIdentity = (
  identity: RegistryIdentity | undefined,
): containerregistry.IdentityProperties_2 | undefined =>
  identity === undefined
    ? undefined
    : {
        type: identity.type,
        userAssignedIdentities: identity.userAssignedIdentities?.length
          ? Object.fromEntries(
              identity.userAssignedIdentities.map((id) => [id, {}]),
            )
          : undefined,
      };

export const TaskProvider = () =>
  Provider.succeed(Task, {
    stables: ["taskName", "taskId", "registry", "resourceGroup", "location"],

    // Tasks live inside a registry; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        !sameName(news.registry, output.registry) ||
        (news.name !== undefined && !sameName(news.name, output.taskName)) ||
        (news.location !== undefined &&
          normalizeLocation(news.location) !==
            normalizeLocation(output.location))
      ) {
        // A kept explicit name must be freed before it can be reused.
        return {
          action: "replace",
          deleteFirst:
            news.name !== undefined && sameName(news.name, output.taskName),
        } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const registry = output?.registry ?? olds?.registry;
      if (resourceGroup === undefined || registry === undefined) {
        return undefined;
      }
      const name =
        output?.taskName ?? olds?.name ?? (yield* createRegistryName(id));
      const observed = yield* getTask(
        subscriptionId,
        resourceGroup,
        registry,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, registry, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.ContainerRegistry");
      const { resourceGroup, registry } = news;
      const name =
        news.name ?? output?.taskName ?? (yield* createRegistryName(id));
      const tags = yield* desiredTags(id, news.tags);
      const status = news.status ?? "Enabled";
      const timeout = news.timeout ?? 3600;
      const agentConfiguration = { cpu: news.agentCpu ?? 2 };
      const trigger = {
        timerTriggers: news.timerTriggers?.map((t) => ({
          ...t,
          status: t.status ?? "Enabled",
        })),
        baseImageTrigger:
          news.baseImageTrigger === undefined
            ? undefined
            : {
                ...news.baseImageTrigger,
                status: news.baseImageTrigger.status ?? "Enabled",
              },
      };
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        registryName: registry,
        taskName: name,
      };
      const get = getTask(subscriptionId, resourceGroup, registry, name);
      const waitReady = waitForProvisioned(
        `task ${name}`,
        get,
        (task) => task.properties?.provisioningState,
        { interval: "2 seconds", times: 30 },
      );

      // Observe.
      let observed = yield* get;

      // Ensure. The task must live in the registry's location.
      if (observed === undefined) {
        const location =
          news.location ??
          output?.location ??
          (yield* getRegistry(subscriptionId, resourceGroup, registry))
            ?.location;
        yield* containerregistry.CreateTask({
          ...where,
          location: location ?? "",
          tags,
          identity: desiredIdentity(news.identity),
          properties: {
            status,
            platform: news.platform,
            agentConfiguration,
            timeout,
            step: stepInput(news.step),
            trigger,
          },
        });
        observed = yield* waitReady;
      } else {
        // Sync each aspect against the observed task.
        const props = observed.properties;
        const changed: containerregistry.TaskPropertiesUpdateParameters = {};
        if ((props?.status ?? "Enabled") !== status) changed.status = status;
        if (!matchesObserved(news.platform, props?.platform)) {
          changed.platform = news.platform;
        }
        if (props?.timeout !== timeout) changed.timeout = timeout;
        if (!matchesObserved(agentConfiguration, props?.agentConfiguration)) {
          changed.agentConfiguration = agentConfiguration;
        }
        if (
          news.step.type !== props?.step?.type ||
          !matchesObserved(comparableStep(news.step), props?.step) ||
          news.step.contextAccessToken !== undefined
        ) {
          changed.step = stepInput(news.step);
        }
        if (!matchesObserved(trigger, props?.trigger)) {
          changed.trigger = trigger;
        }
        const identityType = observed.identity?.type ?? "None";
        const identityChanged =
          (news.identity?.type ?? "None").replace(/\s/g, "").toLowerCase() !==
          identityType.replace(/\s/g, "").toLowerCase();
        const tagsChanged = tagsDiffer(observed.tags, tags);
        if (Object.keys(changed).length > 0 || identityChanged || tagsChanged) {
          yield* containerregistry.UpdateTask({
            ...where,
            tags: tagsChanged ? tags : undefined,
            identity: identityChanged
              ? (desiredIdentity(news.identity) ?? { type: "None" })
              : undefined,
            properties: Object.keys(changed).length > 0 ? changed : undefined,
          });
          observed = yield* waitReady;
        }
      }

      return toAttrs(resourceGroup, registry, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        containerregistry.DeleteTask({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          registryName: output.registry,
          taskName: output.taskName,
        }),
      );
      yield* waitUntilGone(
        `task ${output.taskName}`,
        getTask(
          subscriptionId,
          output.resourceGroup,
          output.registry,
          output.taskName,
        ),
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.ContainerRegistry.Registry",
        "Azure.Resources.ResourceGroup",
      ],
    },
  });
