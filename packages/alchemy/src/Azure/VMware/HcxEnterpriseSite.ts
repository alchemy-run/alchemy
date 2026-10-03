import * as vmware from "@distilled.cloud/azure/vmware";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
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
  redact,
} from "./common.ts";

export interface HcxEnterpriseSiteProps {
  /** Resource group of the private cloud. Changing it replaces the site. */
  resourceGroup: string;
  /** Name of the private cloud. Changing it replaces the site. */
  privateCloud: string;
  /**
   * Name of the HCX enterprise site. If omitted, a unique name is generated from the app, stage, and
   * logical ID. Changing it replaces the site.
   */
  name?: string;
}

export interface HcxEnterpriseSite extends Resource<
  "Azure.VMware.HcxEnterpriseSite",
  HcxEnterpriseSiteProps,
  {
    /** Name of the HCX enterprise site. */
    hcxEnterpriseSiteName: string;
    /** ARM resource ID of the site. */
    hcxEnterpriseSiteResourceId: string;
    /** Resource group of the private cloud. */
    resourceGroup: string;
    /** Name of the private cloud. */
    privateCloud: string;
    /** HCX activation key for the on-premises HCX Connector. */
    activationKey: Redacted.Redacted<string> | undefined;
    /** Key status (`Available`, `Consumed`, `Deactivated`, `Deleted`). */
    status: string | undefined;
    /** Provisioning state. */
    provisioningState: string | undefined;
  },
  never,
  Providers
> {}

/**
 * An HCX enterprise site on an Azure VMware Solution private cloud — issues
 * an activation key for an on-premises HCX Connector. Requires the HCX
 * add-on (`Azure.VMware.Addon` with `addonType: "HCX"`).
 *
 * @see https://learn.microsoft.com/azure/azure-vmware/install-vmware-hcx
 *
 * ### Activating HCX On-Premises
 * **Example:** Issue an HCX activation key
 * ```typescript
 * const hcx = yield* Azure.VMware.Addon("hcx", {
 *   resourceGroup: group.resourceGroupName,
 *   privateCloud: cloud.privateCloudName,
 *   addonType: "HCX",
 *   offer: "VMware MaaS Cloud Provider (Enterprise)",
 * });
 * const site = yield* Azure.VMware.HcxEnterpriseSite("onprem", {
 *   resourceGroup: group.resourceGroupName,
 *   privateCloud: cloud.privateCloudName,
 * });
 * // site.activationKey activates the on-premises HCX Connector.
 * ```
 *
 * @resource
 */
export const HcxEnterpriseSite = Resource<HcxEnterpriseSite>(
  "Azure.VMware.HcxEnterpriseSite",
);

const createName = (id: string) => createAvsName(id, 64);

const getHcxEnterpriseSite = (
  subscriptionId: string,
  resourceGroupName: string,
  privateCloudName: string,
  hcxEnterpriseSiteName: string,
) =>
  orUndefinedIfNotFound(
    vmware.GetHcxEnterpriseSite({
      subscriptionId,
      resourceGroupName,
      privateCloudName,
      hcxEnterpriseSiteName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  privateCloud: string,
  name: string,
  observed: vmware.GetHcxEnterpriseSiteResponse,
): HcxEnterpriseSite["Attributes"] => ({
  hcxEnterpriseSiteName: name,
  hcxEnterpriseSiteResourceId: observed.id ?? "",
  resourceGroup,
  privateCloud,
  activationKey: redact(observed.properties?.activationKey),
  status: observed.properties?.status,
  provisioningState: observed.properties?.provisioningState,
});

export const HcxEnterpriseSiteProvider = () =>
  Provider.succeed(HcxEnterpriseSite, {
    stables: [
      "hcxEnterpriseSiteName",
      "hcxEnterpriseSiteResourceId",
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
        (news.name !== undefined && news.name !== output.hcxEnterpriseSiteName)
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
        output?.hcxEnterpriseSiteName ?? olds?.name ?? (yield* createName(id));
      const observed = yield* getHcxEnterpriseSite(
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
        news.name ?? output?.hcxEnterpriseSiteName ?? (yield* createName(id));
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        privateCloudName: privateCloud,
        hcxEnterpriseSiteName: name,
      };
      const get = getHcxEnterpriseSite(
        subscriptionId,
        resourceGroup,
        privateCloud,
        name,
      );
      const wait = () =>
        waitForProvisioned(
          `AVS HCX enterprise site ${name}`,
          get,
          (value) => value.properties?.provisioningState,
          CHILD_BUDGET,
        );

      // Observe.
      let observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        yield* vmware.HcxEnterpriseSitesCreateOrUpdate({
          ...where,
          properties: {},
        });
      }
      observed = yield* wait();

      return toAttrs(resourceGroup, privateCloud, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        vmware.DeleteHcxEnterpriseSite({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          privateCloudName: output.privateCloud,
          hcxEnterpriseSiteName: output.hcxEnterpriseSiteName,
        }),
      );
      yield* waitUntilGone(
        `AVS HCX enterprise site ${output.hcxEnterpriseSiteName}`,
        getHcxEnterpriseSite(
          subscriptionId,
          output.resourceGroup,
          output.privateCloud,
          output.hcxEnterpriseSiteName,
        ),
        CHILD_BUDGET,
      );
    }),
  });
