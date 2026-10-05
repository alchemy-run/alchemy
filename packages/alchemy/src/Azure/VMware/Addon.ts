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
  isPrivateCloudOwnedByStack,
  parentChanged,
  sameFingerprint,
  sameName,
  secretFingerprint,
  unredact,
} from "./common.ts";

export type AddonType = "SRM" | "VR" | "HCX" | "Arc";

export interface AddonProps {
  /** Resource group of the private cloud. Changing it replaces the add-on. */
  resourceGroup: string;
  /** Name of the private cloud. Changing it replaces the add-on. */
  privateCloud: string;
  /**
   * Add-on type. The add-on's name is the lower-cased type (`srm`, `vr`,
   * `hcx`, `arc`), so a private cloud holds at most one of each. Changing
   * it replaces the add-on.
   */
  addonType: AddonType;
  /** `SRM` only: VMware Site Recovery Manager license key. Write-only. */
  licenseKey?: Redacted.Redacted<string>;
  /** `VR` only: number of vSphere Replication Servers. */
  vrsCount?: number;
  /** `HCX` only: HCX offer, e.g. `VMware MaaS Cloud Provider (Enterprise)`. */
  offer?: string;
  /** `Arc` only: ARM resource ID of the Arc-enabled VMware vCenter. */
  vCenter?: string;
}

export interface Addon extends Resource<
  "Azure.VMware.Addon",
  AddonProps,
  {
    /** Name of the add-on (the lower-cased add-on type). */
    addonName: string;
    /** ARM resource ID of the add-on. */
    addonId: string;
    /** Resource group of the private cloud. */
    resourceGroup: string;
    /** Name of the private cloud. */
    privateCloud: string;
    /** Add-on type. */
    addonType: string;
    /** Provisioning state. */
    provisioningState: string | undefined;
    /** Salted fingerprint of the write-only license key Alchemy last set. */
    secretFingerprint: Redacted.Redacted<string> | undefined;
  },
  never,
  Providers
> {}

/**
 * An add-on on an Azure VMware Solution private cloud: VMware HCX, Site
 * Recovery Manager (SRM), vSphere Replication (VR), or Azure Arc.
 *
 * @see https://learn.microsoft.com/azure/azure-vmware/install-vmware-hcx
 *
 * ### Installing HCX
 * **Example:** HCX Enterprise
 * ```typescript
 * yield* Azure.VMware.Addon("hcx", {
 *   resourceGroup: group.resourceGroupName,
 *   privateCloud: cloud.privateCloudName,
 *   addonType: "HCX",
 *   offer: "VMware MaaS Cloud Provider (Enterprise)",
 * });
 * ```
 *
 * ### Disaster Recovery
 * **Example:** Site Recovery Manager with vSphere Replication
 * ```typescript
 * yield* Azure.VMware.Addon("srm", {
 *   resourceGroup: group.resourceGroupName,
 *   privateCloud: cloud.privateCloudName,
 *   addonType: "SRM",
 *   licenseKey: Redacted.make(srmLicenseKey),
 * });
 * yield* Azure.VMware.Addon("vr", {
 *   resourceGroup: group.resourceGroupName,
 *   privateCloud: cloud.privateCloudName,
 *   addonType: "VR",
 *   vrsCount: 1,
 * });
 * ```
 *
 * @resource
 */
export const Addon = Resource<Addon>("Azure.VMware.Addon");

const addonName = (addonType: string) => addonType.toLowerCase();

const getAddon = (
  subscriptionId: string,
  resourceGroupName: string,
  privateCloudName: string,
  addonName: string,
) =>
  orUndefinedIfNotFound(
    vmware.GetAddon({
      subscriptionId,
      resourceGroupName,
      privateCloudName,
      addonName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  privateCloud: string,
  name: string,
  addon: vmware.GetAddonResponse,
  fingerprint: Redacted.Redacted<string> | undefined,
): Addon["Attributes"] => ({
  addonName: name,
  addonId: addon.id ?? "",
  resourceGroup,
  privateCloud,
  addonType: addon.properties?.addonType ?? "",
  provisioningState: addon.properties?.provisioningState,
  secretFingerprint: fingerprint,
});

export const AddonProvider = () =>
  Provider.succeed(Addon, {
    stables: ["addonName", "addonId", "resourceGroup", "privateCloud"],

    // Add-ons live inside a private cloud; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        parentChanged(news, output) ||
        !sameName(news.addonType, output.addonType)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const privateCloud = output?.privateCloud ?? olds?.privateCloud;
      const addonType = output?.addonType ?? olds?.addonType;
      if (
        resourceGroup === undefined ||
        privateCloud === undefined ||
        addonType === undefined
      ) {
        return undefined;
      }
      const name = addonName(addonType);
      const observed = yield* getAddon(
        subscriptionId,
        resourceGroup,
        privateCloud,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(
        resourceGroup,
        privateCloud,
        name,
        observed,
        output?.secretFingerprint,
      );
      return (yield* isPrivateCloudOwnedByStack(
        subscriptionId,
        resourceGroup,
        privateCloud,
      ))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, AVS_NAMESPACE);
      const { resourceGroup, privateCloud } = news;
      const name = addonName(news.addonType);
      const fingerprint = yield* secretFingerprint(`${privateCloud}/${name}`, [
        news.licenseKey,
      ]);
      const get = getAddon(subscriptionId, resourceGroup, privateCloud, name);
      const wait = () =>
        waitForProvisioned(
          `AVS add-on ${name}`,
          get,
          (addon) => addon.properties?.provisioningState,
          CHILD_BUDGET,
        );

      // Observe.
      const observed = yield* get;
      const props = observed?.properties;

      // Ensure + sync: the PUT is an upsert of the whole add-on, so send it
      // when the add-on is missing or an observable/secret field drifted.
      if (
        observed === undefined ||
        (news.vrsCount !== undefined && props?.vrsCount !== news.vrsCount) ||
        (news.offer !== undefined && props?.offer !== news.offer) ||
        (news.vCenter !== undefined &&
          !sameName(props?.vCenter, news.vCenter)) ||
        !sameFingerprint(fingerprint, output?.secretFingerprint)
      ) {
        yield* vmware.AddonsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          privateCloudName: privateCloud,
          addonName: name,
          properties: {
            addonType: news.addonType,
            licenseKey: unredact(news.licenseKey),
            vrsCount: news.vrsCount,
            offer: news.offer,
            vCenter: news.vCenter,
          },
        });
      }
      const fresh = yield* wait();
      return toAttrs(resourceGroup, privateCloud, name, fresh, fingerprint);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        vmware.DeleteAddon({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          privateCloudName: output.privateCloud,
          addonName: output.addonName,
        }),
      );
      yield* waitUntilGone(
        `AVS add-on ${output.addonName}`,
        getAddon(
          subscriptionId,
          output.resourceGroup,
          output.privateCloud,
          output.addonName,
        ),
        CHILD_BUDGET,
      );
    }),
  });
