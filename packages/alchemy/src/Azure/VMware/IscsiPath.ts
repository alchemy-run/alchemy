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
  isPrivateCloudOwnedByStack,
  parentChanged,
} from "./common.ts";

export interface IscsiPathProps {
  /** Resource group of the private cloud. Changing it replaces the iSCSI path. */
  resourceGroup: string;
  /** Name of the private cloud. Changing it replaces the iSCSI path. */
  privateCloud: string;
  /**
   * CIDR block for the iSCSI path, e.g. `10.10.0.0/24`. Changing it replaces
   * the iSCSI path.
   */
  networkBlock: string;
}

export interface IscsiPath extends Resource<
  "Azure.VMware.IscsiPath",
  IscsiPathProps,
  {
    /** ARM resource ID of the iSCSI path. */
    iscsiPathId: string;
    /** Resource group of the private cloud. */
    resourceGroup: string;
    /** Name of the private cloud. */
    privateCloud: string;
    /** CIDR block of the iSCSI path. */
    networkBlock: string;
    /** Provisioning state. */
    provisioningState: string | undefined;
  },
  never,
  Providers
> {}

/**
 * The iSCSI path of an Azure VMware Solution private cloud — the network
 * used to reach external iSCSI storage such as Elastic SAN. A private cloud
 * has at most one (`iscsiPaths/default`); deleting the resource removes it.
 *
 * @see https://learn.microsoft.com/azure/azure-vmware/configure-azure-elastic-san
 *
 * ### Enabling iSCSI
 * **Example:** iSCSI path for Elastic SAN datastores
 * ```typescript
 * yield* Azure.VMware.IscsiPath("iscsi", {
 *   resourceGroup: group.resourceGroupName,
 *   privateCloud: cloud.privateCloudName,
 *   networkBlock: "10.10.0.0/24",
 * });
 * ```
 *
 * @resource
 */
export const IscsiPath = Resource<IscsiPath>("Azure.VMware.IscsiPath");

const getIscsiPath = (
  subscriptionId: string,
  resourceGroupName: string,
  privateCloudName: string,
) =>
  orUndefinedIfNotFound(
    vmware.GetIscsiPath({
      subscriptionId,
      resourceGroupName,
      privateCloudName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  privateCloud: string,
  path: vmware.GetIscsiPathResponse,
): IscsiPath["Attributes"] => ({
  iscsiPathId: path.id ?? "",
  resourceGroup,
  privateCloud,
  networkBlock: path.properties?.networkBlock ?? "",
  provisioningState: path.properties?.provisioningState,
});

export const IscsiPathProvider = () =>
  Provider.succeed(IscsiPath, {
    stables: ["iscsiPathId", "resourceGroup", "privateCloud"],

    // The iSCSI path lives inside a private cloud; nuke removes it with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        parentChanged(news, output) ||
        news.networkBlock !== output.networkBlock
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const privateCloud = output?.privateCloud ?? olds?.privateCloud;
      if (resourceGroup === undefined || privateCloud === undefined) {
        return undefined;
      }
      const observed = yield* getIscsiPath(
        subscriptionId,
        resourceGroup,
        privateCloud,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, privateCloud, observed);
      return (yield* isPrivateCloudOwnedByStack(
        subscriptionId,
        resourceGroup,
        privateCloud,
      ))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, AVS_NAMESPACE);
      const { resourceGroup, privateCloud } = news;
      const get = getIscsiPath(subscriptionId, resourceGroup, privateCloud);

      // Observe; ensure (the PUT is an upsert of the singleton).
      const observed = yield* get;
      if (
        observed === undefined ||
        observed.properties?.networkBlock !== news.networkBlock
      ) {
        yield* vmware.IscsiPathsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          privateCloudName: privateCloud,
          properties: { networkBlock: news.networkBlock },
        });
      }
      const fresh = yield* waitForProvisioned(
        `AVS iSCSI path of ${privateCloud}`,
        get,
        (path) => path.properties?.provisioningState,
        CHILD_BUDGET,
      );
      return toAttrs(resourceGroup, privateCloud, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        vmware.DeleteIscsiPath({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          privateCloudName: output.privateCloud,
        }),
      );
      yield* waitUntilGone(
        `AVS iSCSI path of ${output.privateCloud}`,
        getIscsiPath(subscriptionId, output.resourceGroup, output.privateCloud),
        CHILD_BUDGET,
      );
    }),
  });
