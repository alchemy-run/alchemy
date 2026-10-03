import * as mission from "@distilled.cloud/azure/mission";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  desiredTags,
  ensureRegistered,
  hasAnyAlchemyTag,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  requireSinglePage,
  resourceGroupOf,
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  changedProperties,
  createMissionName,
  FAST,
  getVirtualEnclave,
  NAMESPACE,
  sameName,
} from "./Common.ts";

export interface WorkloadProps {
  /** Resource group of the enclave. Changing it replaces the workload. */
  resourceGroup: string;
  /** Name of the parent virtual enclave. Changing it replaces the workload. */
  virtualEnclave: string;
  /**
   * Workload name. If omitted, a unique name is generated from the app,
   * stage, and logical ID. Changing it replaces the workload.
   */
  name?: string;
  /**
   * Azure location of the workload. Changing it replaces the workload.
   * @default the enclave's location
   */
  location?: string;
  /**
   * ARM IDs of existing resource groups governed by the workload. If
   * omitted, the service creates the workload's resource group.
   */
  resourceGroupCollection?: string[];
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface Workload extends Resource<
  "Azure.VirtualEnclaves.Workload",
  WorkloadProps,
  {
    /** Name of the workload. */
    workloadName: string;
    /** ARM resource ID of the workload. */
    workloadId: string;
    /** Name of the parent virtual enclave. */
    virtualEnclave: string;
    /** Resource group of the enclave. */
    resourceGroup: string;
    /** Location of the workload. */
    location: string;
    /** ARM IDs of the resource groups governed by the workload. */
    resourceGroupCollection: string[];
    /** Last provisioning state. */
    provisioningState: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A workload — a governed resource group inside an Azure
 * {@link VirtualEnclave} where application resources are deployed under
 * the enclave's policies and role assignments.
 *
 * @see https://learn.microsoft.com/azure/virtual-enclaves/overview
 *
 * ### Creating a Workload
 * **Example:** Workload in an enclave
 * ```typescript
 * const workload = yield* Azure.VirtualEnclaves.Workload("app", {
 *   resourceGroup: group.resourceGroupName,
 *   virtualEnclave: enclave.virtualEnclaveName,
 * });
 * ```
 *
 * @resource
 */
export const Workload = Resource<Workload>("Azure.VirtualEnclaves.Workload");

type Observed = mission.GetWorkloadResponse | mission.WorkloadResource;

const getWorkload = (
  subscriptionId: string,
  resourceGroupName: string,
  virtualEnclaveName: string,
  workloadName: string,
) =>
  orUndefinedIfNotFound(
    mission.GetWorkload({
      subscriptionId,
      resourceGroupName,
      virtualEnclaveName,
      workloadName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  virtualEnclave: string,
  name: string,
  observed: Observed,
): Workload["Attributes"] => ({
  workloadName: name,
  workloadId: observed.id ?? "",
  virtualEnclave,
  resourceGroup,
  location: observed.location,
  resourceGroupCollection: observed.properties?.resourceGroupCollection ?? [],
  provisioningState: observed.properties?.provisioningState,
  tags: userTags(observed.tags),
});

export const WorkloadProvider = () =>
  Provider.succeed(Workload, {
    stables: [
      "workloadName",
      "workloadId",
      "virtualEnclave",
      "resourceGroup",
      "location",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const enclaves = yield* mission
        .ListVirtualEnclaveBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListVirtualEnclaveBySubscription", page),
          ),
        );
      const results: Workload["Attributes"][] = [];
      for (const enclave of enclaves.value) {
        const group = resourceGroupOf(enclave.id);
        if (group === undefined || enclave.name === undefined) continue;
        const page = yield* orUndefinedIfNotFound(
          mission.ListWorkloadByEnclaveResource({
            subscriptionId,
            resourceGroupName: group,
            virtualEnclaveName: enclave.name,
          }),
        );
        if (page === undefined) continue;
        yield* requireSinglePage("ListWorkloadByEnclaveResource", page);
        for (const workload of page.value) {
          if (hasAnyAlchemyTag(workload.tags) && workload.name !== undefined) {
            results.push(toAttrs(group, enclave.name, workload.name, workload));
          }
        }
      }
      return results;
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        !sameName(news.virtualEnclave, output.virtualEnclave) ||
        (news.name !== undefined &&
          !sameName(news.name, output.workloadName)) ||
        (news.location !== undefined &&
          !sameName(news.location, output.location))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const virtualEnclave = output?.virtualEnclave ?? olds?.virtualEnclave;
      if (resourceGroup === undefined || virtualEnclave === undefined) {
        return undefined;
      }
      const name =
        output?.workloadName ?? olds?.name ?? (yield* createMissionName(id));
      const observed = yield* getWorkload(
        subscriptionId,
        resourceGroup,
        virtualEnclave,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, virtualEnclave, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, NAMESPACE);
      const { resourceGroup, virtualEnclave } = news;
      const name =
        news.name ?? output?.workloadName ?? (yield* createMissionName(id));
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        virtualEnclaveName: virtualEnclave,
        workloadName: name,
      };
      const desired = {
        resourceGroupCollection: news.resourceGroupCollection,
      };
      const get = getWorkload(
        subscriptionId,
        resourceGroup,
        virtualEnclave,
        name,
      );
      const waitReady = waitForProvisioned(
        `workload ${name}`,
        get,
        (workload) => workload.properties?.provisioningState,
        FAST,
      );

      // Observe.
      let observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        const parent = news.location
          ? undefined
          : yield* getVirtualEnclave(
              subscriptionId,
              resourceGroup,
              virtualEnclave,
            );
        yield* mission.WorkloadCreateOrUpdate({
          ...where,
          location:
            news.location ??
            output?.location ??
            parent?.location ??
            env.location,
          tags,
          properties: desired,
        });
      }
      observed = yield* waitReady;

      // Sync governed resource groups and tags; PATCH only the deltas.
      const properties = changedProperties(desired, observed.properties);
      const tagsChanged = tagsDiffer(observed.tags, tags);
      if (properties !== undefined || tagsChanged) {
        yield* mission.UpdateWorkload({
          ...where,
          properties,
          tags: tagsChanged ? tags : undefined,
        });
        observed = yield* waitReady;
      }

      return toAttrs(resourceGroup, virtualEnclave, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        mission.DeleteWorkload({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          virtualEnclaveName: output.virtualEnclave,
          workloadName: output.workloadName,
        }),
      );
      yield* waitUntilGone(
        `workload ${output.workloadName}`,
        getWorkload(
          subscriptionId,
          output.resourceGroup,
          output.virtualEnclave,
          output.workloadName,
        ),
        FAST,
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.VirtualEnclaves.VirtualEnclave",
        "Azure.Resources.ResourceGroup",
      ],
    },
  });
