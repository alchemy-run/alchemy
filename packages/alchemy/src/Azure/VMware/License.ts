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
  secretFingerprint,
  unredact,
} from "./common.ts";

export interface LicenseProps {
  /** Resource group of the private cloud. Changing it replaces the license. */
  resourceGroup: string;
  /** Name of the private cloud. Changing it replaces the license. */
  privateCloud: string;
  /**
   * License kind. The license's name equals its kind, so a private cloud
   * holds at most one license of each kind.
   * @default "VmwareFirewall"
   */
  kind?: "VmwareFirewall";
  /** License key. Write-only: Alchemy re-sends it only when it changes. */
  licenseKey: Redacted.Redacted<string>;
  /** ISO 8601 date-time when the license expires. */
  endDate: string;
  /** Broadcom site ID of the license. */
  broadcomSiteId?: string;
  /** Broadcom contract number of the license. */
  broadcomContractNumber?: string;
}

export interface License extends Resource<
  "Azure.VMware.License",
  LicenseProps,
  {
    /** Name of the license (equals its kind). */
    licenseName: string;
    /** ARM resource ID of the license. */
    licenseId: string;
    /** Resource group of the private cloud. */
    resourceGroup: string;
    /** Name of the private cloud. */
    privateCloud: string;
    /** License kind. */
    kind: string;
    /** When the license expires. */
    endDate: string | undefined;
    /** Provisioning state. */
    provisioningState: string | undefined;
    /** Salted fingerprint of the write-only license key Alchemy last set. */
    secretFingerprint: Redacted.Redacted<string> | undefined;
  },
  never,
  Providers
> {}

/**
 * A VMware license applied to an Azure VMware Solution private cloud, e.g.
 * the VMware vDefend (NSX distributed) firewall license.
 *
 * @see https://learn.microsoft.com/azure/azure-vmware/vmware-firewall
 *
 * ### Applying a Firewall License
 * **Example:** VMware Firewall license
 * ```typescript
 * yield* Azure.VMware.License("firewall", {
 *   resourceGroup: group.resourceGroupName,
 *   privateCloud: cloud.privateCloudName,
 *   licenseKey: Redacted.make(firewallLicenseKey),
 *   endDate: "2027-12-31T00:00:00Z",
 *   broadcomSiteId: "123456",
 * });
 * ```
 *
 * @resource
 */
export const License = Resource<License>("Azure.VMware.License");

const getLicense = (
  subscriptionId: string,
  resourceGroupName: string,
  privateCloudName: string,
  licenseName: string,
) =>
  orUndefinedIfNotFound(
    vmware.GetLicense({
      subscriptionId,
      resourceGroupName,
      privateCloudName,
      licenseName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  privateCloud: string,
  name: string,
  license: vmware.GetLicenseResponse,
  fingerprint: Redacted.Redacted<string> | undefined,
): License["Attributes"] => ({
  licenseName: name,
  licenseId: license.id ?? "",
  resourceGroup,
  privateCloud,
  kind: license.properties?.kind ?? name,
  endDate: license.properties?.endDate,
  provisioningState: license.properties?.provisioningState,
  secretFingerprint: fingerprint,
});

const instant = (value: string | undefined) =>
  value === undefined ? undefined : new Date(value).getTime();

export const LicenseProvider = () =>
  Provider.succeed(License, {
    stables: ["licenseName", "licenseId", "resourceGroup", "privateCloud"],

    // Licenses live inside a private cloud; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        parentChanged(news, output) ||
        (news.kind ?? "VmwareFirewall") !== output.licenseName
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
      const name = output?.licenseName ?? olds?.kind ?? "VmwareFirewall";
      const observed = yield* getLicense(
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
      const name = news.kind ?? "VmwareFirewall";
      const fingerprint = yield* secretFingerprint(`${privateCloud}/${name}`, [
        news.licenseKey,
      ]);
      const get = getLicense(subscriptionId, resourceGroup, privateCloud, name);

      // Observe.
      const observed = yield* get;
      const props = observed?.properties;

      // Ensure + sync: the PUT replaces the whole license, so send it when
      // missing, when an observable field drifted, or the key changed.
      const endDate = yield* Effect.sync(() => instant(news.endDate));
      const observedEndDate = yield* Effect.sync(() => instant(props?.endDate));
      if (
        observed === undefined ||
        observedEndDate !== endDate ||
        (news.broadcomSiteId !== undefined &&
          props?.broadcomSiteId !== news.broadcomSiteId) ||
        (news.broadcomContractNumber !== undefined &&
          props?.broadcomContractNumber !== news.broadcomContractNumber) ||
        !sameFingerprint(fingerprint, output?.secretFingerprint)
      ) {
        yield* vmware.LicensesCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          privateCloudName: privateCloud,
          licenseName: name,
          properties: {
            kind: name,
            licenseKey: unredact(news.licenseKey),
            endDate: news.endDate,
            broadcomSiteId: news.broadcomSiteId,
            broadcomContractNumber: news.broadcomContractNumber,
          },
        });
      }
      const fresh = yield* waitForProvisioned(
        `AVS license ${name}`,
        get,
        (license) => license.properties?.provisioningState,
        CHILD_BUDGET,
      );
      return toAttrs(resourceGroup, privateCloud, name, fresh, fingerprint);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        vmware.DeleteLicense({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          privateCloudName: output.privateCloud,
          licenseName: output.licenseName,
        }),
      );
      yield* waitUntilGone(
        `AVS license ${output.licenseName}`,
        getLicense(
          subscriptionId,
          output.resourceGroup,
          output.privateCloud,
          output.licenseName,
        ),
        CHILD_BUDGET,
      );
    }),
  });
