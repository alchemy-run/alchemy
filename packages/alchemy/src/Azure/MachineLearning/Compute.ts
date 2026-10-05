import * as ml from "@distilled.cloud/azure/machinelearningservices";
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
  ProvisioningFailed,
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  createChildName,
  type MachineLearningIdentity,
  sameArm,
  sameValue,
  toArmIdentity,
  workspaceLocation,
  inputFields,
} from "./Common.ts";

export type ComputeType =
  | "AmlCompute"
  | "ComputeInstance"
  | "Kubernetes"
  | "AKS"
  | "VirtualMachine"
  | "Databricks"
  | "HDInsight"
  | "DataFactory"
  | "SynapseSpark"
  | "DataLakeAnalytics";

export interface ComputeScaleSettings {
  /** Maximum number of nodes. */
  maxNodeCount: number;
  /**
   * Minimum number of nodes. Keep `0` so an idle cluster costs nothing.
   * @default 0
   */
  minNodeCount?: number;
  /**
   * Idle time before nodes scale down, as an ISO 8601 duration (e.g.
   * `PT120S`).
   */
  nodeIdleTimeBeforeScaleDown?: string;
}

export interface ComputeProps {
  /** Resource group of the workspace. Changing it replaces the compute. */
  resourceGroup: string;
  /** Workspace that owns the compute. Changing it replaces the compute. */
  workspace: string;
  /**
   * Compute name: 2-16 letters, digits, and hyphens, starting with a
   * letter. If omitted, a unique name is generated from the logical ID.
   * Changing it replaces the compute.
   */
  name?: string;
  /**
   * Azure location of the compute. Changing it replaces the compute.
   * @default the workspace's location
   */
  location?: string;
  /**
   * Compute type. Changing it replaces the compute.
   * @default "AmlCompute"
   */
  computeType?: ComputeType;
  /**
   * VM size of the nodes (`AmlCompute`, `ComputeInstance`), e.g.
   * `Standard_DS3_v2`. Changing it replaces the compute.
   */
  vmSize?: string;
  /**
   * VM priority (`AmlCompute`). Changing it replaces the compute.
   * @default "Dedicated"
   */
  vmPriority?: "Dedicated" | "LowPriority";
  /**
   * Autoscale settings of an `AmlCompute` cluster; updated in place.
   */
  scaleSettings?: ComputeScaleSettings;
  /**
   * Additional per-type properties sent as-is in `properties.properties`
   * (e.g. `remoteLoginPortPublicAccess`, `enableNodePublicIp`). Changing
   * them replaces the compute.
   */
  properties?: Record<string, unknown>;
  /**
   * ARM resource ID of an existing compute to attach (`Kubernetes`, `AKS`,
   * `VirtualMachine`, `Databricks`, ...). Changing it replaces the compute.
   */
  resourceId?: string;
  /** Description of the compute. Changing it replaces the compute. */
  description?: string;
  /**
   * Disable local (key-based) authentication. Changing it replaces the
   * compute.
   */
  disableLocalAuth?: boolean;
  /** Managed identity of the compute. Changing it replaces the compute. */
  identity?: MachineLearningIdentity;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface Compute extends Resource<
  "Azure.MachineLearning.Compute",
  ComputeProps,
  {
    /** Name of the compute. */
    computeName: string;
    /** ARM resource ID of the compute. */
    computeId: string;
    /** Workspace that owns the compute. */
    workspace: string;
    /** Resource group of the workspace. */
    resourceGroup: string;
    /** Location of the compute. */
    location: string;
    /** Compute type. */
    computeType: string;
    /** VM size of the nodes, when applicable. */
    vmSize: string | undefined;
    /** VM priority, when applicable. */
    vmPriority: string | undefined;
    /** Whether the compute is attached rather than created by the workspace. */
    isAttachedCompute: boolean;
    /** Principal ID of the system-assigned identity, if any. */
    principalId: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * Compute for an Azure Machine Learning workspace: an autoscaling
 * `AmlCompute` cluster, a `ComputeInstance` development VM, or an
 * attached compute target (Kubernetes, Databricks, ...).
 *
 * Cluster autoscale settings are updated in place; every other change
 * replaces the compute. An `AmlCompute` cluster with `minNodeCount: 0`
 * costs nothing while idle.
 *
 * @see https://learn.microsoft.com/azure/machine-learning/concept-compute-target
 *
 * ### Creating Compute
 * **Example:** Autoscaling CPU cluster that scales to zero
 * ```typescript
 * const cluster = yield* Azure.MachineLearning.Compute("cpu", {
 *   resourceGroup: group.resourceGroupName,
 *   workspace: workspace.workspaceName,
 *   vmSize: "Standard_DS3_v2",
 *   scaleSettings: { minNodeCount: 0, maxNodeCount: 4 },
 * });
 * ```
 *
 * **Example:** Low-priority cluster with a short idle timeout
 * ```typescript
 * const cluster = yield* Azure.MachineLearning.Compute("spot", {
 *   resourceGroup: group.resourceGroupName,
 *   workspace: workspace.workspaceName,
 *   vmSize: "Standard_DS3_v2",
 *   vmPriority: "LowPriority",
 *   scaleSettings: {
 *     maxNodeCount: 2,
 *     nodeIdleTimeBeforeScaleDown: "PT120S",
 *   },
 * });
 * ```
 *
 * @resource
 */
export const Compute = Resource<Compute>("Azure.MachineLearning.Compute");

const getCompute = (
  subscriptionId: string,
  resourceGroupName: string,
  workspaceName: string,
  computeName: string,
) =>
  orUndefinedIfNotFound(
    ml.GetCompute({
      subscriptionId,
      resourceGroupName,
      workspaceName,
      computeName,
    }),
  );

type ComputeTypeProperties = {
  vmSize?: string;
  vmPriority?: string;
  scaleSettings?: {
    maxNodeCount?: number;
    minNodeCount?: number;
    nodeIdleTimeBeforeScaleDown?: string;
  };
};

const typeProperties = (compute: ml.GetComputeResponse) => {
  const props = compute.properties?.properties;
  return (
    props !== null && typeof props === "object" ? props : {}
  ) as ComputeTypeProperties;
};

const toAttrs = (
  resourceGroup: string,
  workspace: string,
  name: string,
  compute: ml.GetComputeResponse,
): Compute["Attributes"] => {
  const props = typeProperties(compute);
  return {
    computeName: name,
    computeId: compute.id ?? "",
    workspace,
    resourceGroup,
    location: compute.location ?? "",
    computeType: compute.properties?.computeType ?? "",
    vmSize: props.vmSize,
    vmPriority: props.vmPriority,
    isAttachedCompute: compute.properties?.isAttachedCompute ?? false,
    principalId: compute.identity?.principalId,
    tags: userTags(compute.tags ?? undefined),
  };
};

const desiredScale = (scale: ComputeScaleSettings | undefined) =>
  scale === undefined
    ? undefined
    : {
        maxNodeCount: scale.maxNodeCount,
        minNodeCount: scale.minNodeCount ?? 0,
        nodeIdleTimeBeforeScaleDown: scale.nodeIdleTimeBeforeScaleDown,
      };

export const ComputeProvider = () =>
  Provider.succeed(Compute, {
    stables: [
      "computeName",
      "computeId",
      "workspace",
      "resourceGroup",
      "location",
      "computeType",
    ],

    // Compute is deleted with its workspace.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (output === undefined) return undefined;
      // Parent names are stable upstream; an unresolved one means the
      // parent is being replaced.
      const fields = inputFields(news);
      if (
        fields === undefined ||
        !isResolved(fields.resourceGroup) ||
        !isResolved(fields.workspace)
      ) {
        return { action: "replace" } as const;
      }
      if (!isResolved(news)) return undefined;
      if (
        !sameArm(news.resourceGroup, output.resourceGroup) ||
        !sameArm(news.workspace, output.workspace) ||
        (news.name !== undefined && !sameArm(news.name, output.computeName)) ||
        (news.location !== undefined &&
          !sameArm(news.location, output.location)) ||
        !sameArm(news.computeType ?? "AmlCompute", output.computeType) ||
        (news.vmSize !== undefined && !sameArm(news.vmSize, output.vmSize)) ||
        (news.vmPriority !== undefined &&
          !sameArm(news.vmPriority, output.vmPriority))
      ) {
        return { action: "replace" } as const;
      }
      if (
        olds !== undefined &&
        (!sameValue(news.properties, olds.properties) ||
          news.resourceId !== olds.resourceId ||
          news.description !== olds.description ||
          news.disableLocalAuth !== olds.disableLocalAuth ||
          !sameValue(news.identity, olds.identity))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const workspace = output?.workspace ?? olds?.workspace;
      if (resourceGroup === undefined || workspace === undefined) {
        return undefined;
      }
      const name =
        output?.computeName ?? olds?.name ?? (yield* createChildName(id, 16));
      const observed = yield* getCompute(
        subscriptionId,
        resourceGroup,
        workspace,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, workspace, name, observed);
      return (yield* isOwned(id, observed.tags ?? undefined))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(
        subscriptionId,
        "Microsoft.MachineLearningServices",
      );
      const { resourceGroup, workspace } = news;
      const name =
        news.name ?? output?.computeName ?? (yield* createChildName(id, 16));
      const computeType = news.computeType ?? "AmlCompute";
      const tags = yield* desiredTags(id, news.tags);
      const scaleSettings = desiredScale(news.scaleSettings);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        workspaceName: workspace,
        computeName: name,
      };
      const get = getCompute(subscriptionId, resourceGroup, workspace, name);
      const waitReady = waitForProvisioned(
        `machine learning compute ${name}`,
        get,
        (compute) => compute.properties?.provisioningState,
        // Compute instances regularly take 10-20 minutes to provision.
        { interval: "10 seconds", times: 150 },
      ).pipe(
        // Surface Azure's provisioning errors (e.g. exhausted core quota).
        Effect.catchTag("Azure.ProvisioningFailed", (failure) =>
          get.pipe(
            Effect.flatMap((compute) => {
              const errors = (compute?.properties?.provisioningErrors ?? [])
                .flatMap((item) =>
                  item.error === undefined
                    ? []
                    : [`${item.error.code}: ${item.error.message}`],
                )
                .join("; ");
              return Effect.fail(
                errors.length === 0
                  ? failure
                  : new ProvisioningFailed({
                      resource: failure.resource,
                      state: failure.state,
                      message: `${failure.message}: ${errors}`,
                    }),
              );
            }),
          ),
        ),
      );

      // Observe.
      let observed = yield* get;

      // Ensure. Creation is a long-running operation. Re-sending the PUT
      // with identical properties is how tags are updated.
      const tagsChanged =
        observed !== undefined && tagsDiffer(observed.tags ?? undefined, tags);
      if (observed === undefined || tagsChanged) {
        const location =
          news.location ??
          output?.location ??
          observed?.location ??
          (yield* workspaceLocation(subscriptionId, resourceGroup, workspace));
        const observedProps =
          observed === undefined ? undefined : typeProperties(observed);
        yield* ml.ComputeCreateOrUpdate({
          ...where,
          location,
          tags,
          identity: toArmIdentity(news.identity),
          properties: {
            computeType,
            description: news.description,
            resourceId: news.resourceId,
            disableLocalAuth: news.disableLocalAuth,
            properties: {
              ...news.properties,
              ...(news.vmSize !== undefined ? { vmSize: news.vmSize } : {}),
              ...(news.vmPriority !== undefined
                ? { vmPriority: news.vmPriority }
                : {}),
              ...(scaleSettings !== undefined
                ? {
                    scaleSettings:
                      observedProps?.scaleSettings ?? scaleSettings,
                  }
                : {}),
            },
          },
        });
      }
      observed = yield* waitReady;

      // Sync autoscale settings (the only in-place property).
      if (scaleSettings !== undefined) {
        const observedScale = typeProperties(observed).scaleSettings;
        if (
          observedScale?.maxNodeCount !== scaleSettings.maxNodeCount ||
          (observedScale?.minNodeCount ?? 0) !== scaleSettings.minNodeCount ||
          (scaleSettings.nodeIdleTimeBeforeScaleDown !== undefined &&
            observedScale?.nodeIdleTimeBeforeScaleDown !==
              scaleSettings.nodeIdleTimeBeforeScaleDown)
        ) {
          yield* ml.UpdateCompute({
            ...where,
            properties: { properties: { scaleSettings } },
          });
          observed = yield* waitReady;
        }
      }

      return toAttrs(resourceGroup, workspace, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        ml.DeleteCompute({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          workspaceName: output.workspace,
          computeName: output.computeName,
          underlyingResourceAction: output.isAttachedCompute
            ? "Detach"
            : "Delete",
        }),
      );
      yield* waitUntilGone(
        `machine learning compute ${output.computeName}`,
        getCompute(
          subscriptionId,
          output.resourceGroup,
          output.workspace,
          output.computeName,
        ),
        { interval: "10 seconds", times: 90 },
      );
    }),

    nuke: { dependsOn: ["Azure.MachineLearning.Workspace"] },
  });
