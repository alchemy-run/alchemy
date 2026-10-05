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

export interface CloudLinkProps {
  /** Resource group of the private cloud. Changing it replaces the link. */
  resourceGroup: string;
  /** Name of the private cloud. Changing it replaces the link. */
  privateCloud: string;
  /**
   * Name of the cloud link. If omitted, a unique name is generated from the
   * app, stage, and logical ID. Changing it replaces the link.
   */
  name?: string;
  /**
   * ARM resource ID of the other private cloud to link to. Changing it
   * replaces the link.
   */
  linkedCloud: string;
}

export interface CloudLink extends Resource<
  "Azure.VMware.CloudLink",
  CloudLinkProps,
  {
    /** Name of the cloud link. */
    cloudLinkName: string;
    /** ARM resource ID of the cloud link. */
    cloudLinkId: string;
    /** Resource group of the private cloud. */
    resourceGroup: string;
    /** Name of the private cloud. */
    privateCloud: string;
    /** ARM resource ID of the linked private cloud. */
    linkedCloud: string | undefined;
    /** Link state (`Active`, `Building`, `Disconnected`, ...). */
    status: string | undefined;
    /** Provisioning state. */
    provisioningState: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A cloud link between two Azure VMware Solution private clouds, used to
 * stretch vSAN clusters or enable cross-cloud vCenter features.
 *
 * @see https://learn.microsoft.com/azure/azure-vmware/create-cloud-link
 *
 * ### Linking Private Clouds
 * **Example:** Link two private clouds
 * ```typescript
 * yield* Azure.VMware.CloudLink("link", {
 *   resourceGroup: group.resourceGroupName,
 *   privateCloud: primary.privateCloudName,
 *   linkedCloud: secondary.privateCloudId,
 * });
 * ```
 *
 * @resource
 */
export const CloudLink = Resource<CloudLink>("Azure.VMware.CloudLink");

const createName = (id: string) => createAvsName(id, 64);

const getCloudLink = (
  subscriptionId: string,
  resourceGroupName: string,
  privateCloudName: string,
  cloudLinkName: string,
) =>
  orUndefinedIfNotFound(
    vmware.GetCloudLink({
      subscriptionId,
      resourceGroupName,
      privateCloudName,
      cloudLinkName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  privateCloud: string,
  name: string,
  link: vmware.GetCloudLinkResponse,
): CloudLink["Attributes"] => ({
  cloudLinkName: name,
  cloudLinkId: link.id ?? "",
  resourceGroup,
  privateCloud,
  linkedCloud: link.properties?.linkedCloud,
  status: link.properties?.status,
  provisioningState: link.properties?.provisioningState,
});

export const CloudLinkProvider = () =>
  Provider.succeed(CloudLink, {
    stables: ["cloudLinkName", "cloudLinkId", "resourceGroup", "privateCloud"],

    // Cloud links live inside a private cloud; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        parentChanged(news, output) ||
        (news.name !== undefined && news.name !== output.cloudLinkName) ||
        !sameName(news.linkedCloud, output.linkedCloud)
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
        output?.cloudLinkName ?? olds?.name ?? (yield* createName(id));
      const observed = yield* getCloudLink(
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
        news.name ?? output?.cloudLinkName ?? (yield* createName(id));
      const get = getCloudLink(
        subscriptionId,
        resourceGroup,
        privateCloud,
        name,
      );

      // Observe; ensure. The linked cloud is immutable (replace on change).
      const observed = yield* get;
      if (observed === undefined) {
        yield* vmware.CloudLinksCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          privateCloudName: privateCloud,
          cloudLinkName: name,
          properties: { linkedCloud: news.linkedCloud },
        });
      }
      const fresh = yield* waitForProvisioned(
        `AVS cloud link ${name}`,
        get,
        (link) => link.properties?.provisioningState,
        CHILD_BUDGET,
      );
      return toAttrs(resourceGroup, privateCloud, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        vmware.DeleteCloudLink({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          privateCloudName: output.privateCloud,
          cloudLinkName: output.cloudLinkName,
        }),
      );
      yield* waitUntilGone(
        `AVS cloud link ${output.cloudLinkName}`,
        getCloudLink(
          subscriptionId,
          output.resourceGroup,
          output.privateCloud,
          output.cloudLinkName,
        ),
        CHILD_BUDGET,
      );
    }),
  });
