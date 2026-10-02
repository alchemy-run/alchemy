import * as vmware from "@distilled.cloud/azure/vmware";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  AVS_NAMESPACE,
  CHILD_BUDGET,
  createAvsName,
  isPrivateCloudOwnedByStack,
  parentChanged,
  sameName,
} from "./common.ts";

export interface PureStoragePolicyProps {
  /** Resource group of the private cloud. Changing it replaces the policy. */
  resourceGroup: string;
  /** Name of the private cloud. Changing it replaces the policy. */
  privateCloud: string;
  /**
   * Name of the storage policy. If omitted, a unique name is generated from the app, stage, and
   * logical ID. Changing it replaces the policy.
   */
  name?: string;
  /**
   * Pure Storage policy-based management (SPBM) policy definition.
   * Changing it replaces the policy.
   */
  storagePolicyDefinition: string;
  /**
   * Azure resource ID of the Pure Storage pool (`PureStorage.Block`).
   * Changing it replaces the policy.
   */
  storagePoolId: string;
}

export interface PureStoragePolicy extends Resource<
  "Azure.VMware.PureStoragePolicy",
  PureStoragePolicyProps,
  {
    /** Name of the storage policy. */
    storagePolicyName: string;
    /** ARM resource ID of the policy. */
    storagePolicyResourceId: string;
    /** Resource group of the private cloud. */
    resourceGroup: string;
    /** Name of the private cloud. */
    privateCloud: string;
    /** Azure resource ID of the Pure Storage pool. */
    storagePoolId: string;
    /** Provisioning state. */
    provisioningState: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A Pure Storage Cloud storage policy (SPBM) on an Azure VMware Solution
 * private cloud. Needs a `PureStorage.Block` storage pool, a marketplace
 * partner offer.
 *
 * @see https://learn.microsoft.com/azure/azure-vmware/configure-pure-cloud-block-store
 *
 * ### Creating a Storage Policy
 * **Example:** Pure Storage SPBM policy
 * ```typescript
 * yield* Azure.VMware.PureStoragePolicy("gold", {
 *   resourceGroup: group.resourceGroupName,
 *   privateCloud: cloud.privateCloudName,
 *   storagePolicyDefinition: policyDefinition,
 *   storagePoolId: storagePoolId,
 * });
 * ```
 *
 * @resource
 */
export const PureStoragePolicy = Resource<PureStoragePolicy>(
  "Azure.VMware.PureStoragePolicy",
);

const createName = (id: string) => createAvsName(id, 64);

const getPureStoragePolicy = (
  subscriptionId: string,
  resourceGroupName: string,
  privateCloudName: string,
  storagePolicyName: string,
) =>
  orUndefinedIfNotFound(
    vmware.GetPureStoragePolicy({
      subscriptionId,
      resourceGroupName,
      privateCloudName,
      storagePolicyName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  privateCloud: string,
  name: string,
  observed: vmware.GetPureStoragePolicyResponse,
): PureStoragePolicy["Attributes"] => ({
  storagePolicyName: name,
  storagePolicyResourceId: observed.id ?? "",
  resourceGroup,
  privateCloud,
  storagePoolId: observed.properties?.storagePoolId ?? "",
  provisioningState: observed.properties?.provisioningState,
});

export const PureStoragePolicyProvider = () =>
  Provider.succeed(PureStoragePolicy, {
    stables: [
      "storagePolicyName",
      "storagePolicyResourceId",
      "resourceGroup",
      "privateCloud",
    ],

    // Lives inside a private cloud; nuke removes it with the private cloud.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        parentChanged(news, output) ||
        (news.name !== undefined && news.name !== output.storagePolicyName) ||
        !sameName(news.storagePoolId, output.storagePoolId) ||
        (olds !== undefined &&
          news.storagePolicyDefinition !== olds.storagePolicyDefinition)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const privateCloud = output?.privateCloud ?? olds?.privateCloud;
      if (resourceGroup === undefined || privateCloud === undefined) {
        return undefined;
      }
      const name =
        output?.storagePolicyName ?? olds?.name ?? (yield* createName(id));
      const observed = yield* getPureStoragePolicy(
        subscriptionId,
        resourceGroup,
        privateCloud,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, privateCloud, name, observed);
      return (yield* isPrivateCloudOwnedByStack(
        subscriptionId,
        resourceGroup,
        privateCloud,
      ))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, AVS_NAMESPACE);
      const { resourceGroup, privateCloud } = news;
      const name =
        news.name ?? output?.storagePolicyName ?? (yield* createName(id));
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        privateCloudName: privateCloud,
        storagePolicyName: name,
      };
      const get = getPureStoragePolicy(
        subscriptionId,
        resourceGroup,
        privateCloud,
        name,
      );
      const wait = () =>
        waitForProvisioned(
          `AVS Pure Storage policy ${name}`,
          get,
          (value) => value.properties?.provisioningState,
          CHILD_BUDGET,
        );

      // Observe.
      let observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        yield* vmware.PureStoragePoliciesCreateOrUpdate({
          ...where,
          properties: {
            storagePolicyDefinition: news.storagePolicyDefinition,
            storagePoolId: news.storagePoolId,
          },
        });
      }
      observed = yield* wait();

      return toAttrs(resourceGroup, privateCloud, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        vmware.DeletePureStoragePolicy({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          privateCloudName: output.privateCloud,
          storagePolicyName: output.storagePolicyName,
        }),
      );
      yield* waitUntilGone(
        `AVS Pure Storage policy ${output.storagePolicyName}`,
        getPureStoragePolicy(
          subscriptionId,
          output.resourceGroup,
          output.privateCloud,
          output.storagePolicyName,
        ),
        CHILD_BUDGET,
      );
    }),
  });
