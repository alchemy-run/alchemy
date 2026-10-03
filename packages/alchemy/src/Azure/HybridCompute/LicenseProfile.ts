import * as hybridcompute from "@distilled.cloud/azure/hybridcompute";
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
import { machineLocation } from "./MachineCommon.ts";

export interface LicenseProfileProps {
  /** Resource group of the Arc machine. Changing it replaces the profile. */
  resourceGroup: string;
  /** Name of the Arc machine. Changing it replaces the profile. */
  machineName: string;
  /**
   * Azure location; must match the machine's location. Changing it
   * replaces the profile.
   * @default the machine's location
   */
  location?: string;
  /**
   * ARM ID of the `HybridCompute.License` (ESU) assigned to the machine.
   */
  assignedLicense?: string;
  /**
   * Whether the machine is covered by Software Assurance, which unlocks
   * Azure benefits for Windows Server.
   */
  softwareAssuranceCustomer?: boolean;
  /** Product licensed pay-as-you-go through Azure Arc. */
  productType?: "WindowsServer" | "WindowsIoTEnterprise";
  /** Whether the pay-as-you-go product subscription is enabled. */
  subscriptionStatus?: "Enabled" | "Disabled";
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface LicenseProfile extends Resource<
  "Azure.HybridCompute.LicenseProfile",
  LicenseProfileProps,
  {
    /** Name of the Arc machine. */
    machineName: string;
    /** Resource group of the Arc machine. */
    resourceGroup: string;
    /** ARM resource ID of the license profile. */
    licenseProfileId: string;
    /** Location of the profile. */
    location: string;
    /** Assigned ESU license, if any. */
    assignedLicense: string | undefined;
    /** ESU eligibility of the machine. */
    esuEligibility: string | undefined;
    /** Whether an ESU key is active on the machine. */
    esuKeyState: string | undefined;
    /** Whether Software Assurance is declared. */
    softwareAssuranceCustomer: boolean | undefined;
    /** Pay-as-you-go product type. */
    productType: string | undefined;
    /** Pay-as-you-go subscription status. */
    subscriptionStatus: string | undefined;
    /** Provisioning state reported by Azure. */
    provisioningState: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * The license profile of an Azure Arc-enabled Windows server: assigns an
 * Extended Security Updates `License`, declares Software Assurance, or
 * enables pay-as-you-go Windows Server licensing. Each machine has one
 * profile, named `default`.
 *
 * The machine must be a connected Windows server.
 *
 * @see https://learn.microsoft.com/azure/azure-arc/servers/license-extended-security-updates
 *
 * ### Assigning Licenses
 * **Example:** Assign an ESU license to a server
 * ```typescript
 * const license = yield* Azure.HybridCompute.License("esu", {
 *   resourceGroup: "arc",
 *   target: "Windows Server 2012",
 *   edition: "Standard",
 *   coreType: "vCore",
 *   processors: 8,
 *   state: "Activated",
 * });
 * yield* Azure.HybridCompute.LicenseProfile("esu-assignment", {
 *   resourceGroup: "arc",
 *   machineName: "win-2012",
 *   assignedLicense: license.licenseId,
 * });
 * ```
 *
 * ### Software Assurance
 * **Example:** Declare Software Assurance coverage
 * ```typescript
 * yield* Azure.HybridCompute.LicenseProfile("sa", {
 *   resourceGroup: "arc",
 *   machineName: "win-2022",
 *   softwareAssuranceCustomer: true,
 * });
 * ```
 *
 * @resource
 */
export const LicenseProfile = Resource<LicenseProfile>(
  "Azure.HybridCompute.LicenseProfile",
);

type ObservedProfile = hybridcompute.GetLicenseProfileResponse;

const PROFILE_NAME = "default";

const getProfile = (
  subscriptionId: string,
  resourceGroupName: string,
  machineName: string,
) =>
  orUndefinedIfNotFound(
    hybridcompute.GetLicenseProfile({
      subscriptionId,
      resourceGroupName,
      machineName,
      licenseProfileName: PROFILE_NAME,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  machineName: string,
  profile: ObservedProfile,
): LicenseProfile["Attributes"] => ({
  machineName,
  resourceGroup,
  licenseProfileId: profile.id ?? "",
  location: profile.location,
  assignedLicense: profile.properties?.esuProfile?.assignedLicense,
  esuEligibility: profile.properties?.esuProfile?.esuEligibility,
  esuKeyState: profile.properties?.esuProfile?.esuKeyState,
  softwareAssuranceCustomer:
    profile.properties?.softwareAssurance?.softwareAssuranceCustomer,
  productType: profile.properties?.productProfile?.productType,
  subscriptionStatus: profile.properties?.productProfile?.subscriptionStatus,
  provisioningState: profile.properties?.provisioningState,
  tags: userTags(profile.tags),
});

const differs = (a: string | undefined, b: string | undefined) =>
  (a ?? "").toLowerCase() !== (b ?? "").toLowerCase();

const budget = { interval: "10 seconds", times: 36 } as const;

export const LicenseProfileProvider = () =>
  Provider.succeed(LicenseProfile, {
    stables: ["machineName", "resourceGroup", "licenseProfileId", "location"],

    // License profiles are deleted with their machine.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        differs(news.resourceGroup, output.resourceGroup) ||
        differs(news.machineName, output.machineName) ||
        (news.location !== undefined && differs(news.location, output.location))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const machineName = output?.machineName ?? olds?.machineName;
      if (resourceGroup === undefined || machineName === undefined) {
        return undefined;
      }
      const observed = yield* getProfile(
        subscriptionId,
        resourceGroup,
        machineName,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, machineName, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.HybridCompute");
      const resourceGroup = news.resourceGroup;
      const machineName = news.machineName;
      const tags = yield* desiredTags(id, news.tags);
      const label = `arc license profile ${machineName}`;
      const get = getProfile(subscriptionId, resourceGroup, machineName);

      // Observe.
      let observed = yield* get;
      const props = observed?.properties;

      // Ensure + sync: the PUT upserts the whole profile.
      if (
        observed === undefined ||
        (news.assignedLicense !== undefined &&
          differs(props?.esuProfile?.assignedLicense, news.assignedLicense)) ||
        (news.softwareAssuranceCustomer !== undefined &&
          props?.softwareAssurance?.softwareAssuranceCustomer !==
            news.softwareAssuranceCustomer) ||
        (news.productType !== undefined &&
          differs(props?.productProfile?.productType, news.productType)) ||
        (news.subscriptionStatus !== undefined &&
          differs(
            props?.productProfile?.subscriptionStatus,
            news.subscriptionStatus,
          )) ||
        tagsDiffer(observed.tags, tags)
      ) {
        const location =
          news.location ??
          observed?.location ??
          output?.location ??
          (yield* machineLocation(subscriptionId, resourceGroup, machineName));
        yield* hybridcompute.LicenseProfilesCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          machineName,
          licenseProfileName: PROFILE_NAME,
          location,
          tags,
          properties: {
            ...(news.softwareAssuranceCustomer !== undefined
              ? {
                  softwareAssurance: {
                    softwareAssuranceCustomer: news.softwareAssuranceCustomer,
                  },
                }
              : {}),
            ...(news.assignedLicense !== undefined
              ? { esuProfile: { assignedLicense: news.assignedLicense } }
              : {}),
            ...(news.productType !== undefined ||
            news.subscriptionStatus !== undefined
              ? {
                  productProfile: {
                    productType: news.productType,
                    subscriptionStatus: news.subscriptionStatus,
                  },
                }
              : {}),
          },
        });
      }
      observed = yield* waitForProvisioned(
        label,
        get,
        (profile) => profile.properties?.provisioningState,
        budget,
      );

      return toAttrs(resourceGroup, machineName, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        hybridcompute.DeleteLicenseProfile({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          machineName: output.machineName,
          licenseProfileName: PROFILE_NAME,
        }),
      );
      yield* waitUntilGone(
        `arc license profile ${output.machineName}`,
        getProfile(subscriptionId, output.resourceGroup, output.machineName),
        budget,
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.Resources.ResourceGroup",
        "Azure.HybridCompute.Machine",
      ],
    },
  });
