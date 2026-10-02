import * as devtestlabs from "@distilled.cloud/azure/devtestlabs";
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
  createLabResourceName,
  DEVTESTLAB_NAMESPACE,
  diverges,
  getLab,
} from "./Common.ts";

export interface LabAnnouncement {
  /** Plain-text title of the banner. */
  title?: string;
  /** Markdown body of the banner. */
  markdown?: string;
  /** Whether the banner is shown. */
  enabled?: "Enabled" | "Disabled";
  /** ISO 8601 time the banner expires (omit for never). */
  expirationDate?: string;
}

export interface LabSupport {
  /** Whether the support banner is shown. */
  enabled?: "Enabled" | "Disabled";
  /** Markdown body of the support banner. */
  markdown?: string;
}

export interface LabProps {
  /** Resource group of the lab. Changing it replaces the lab. */
  resourceGroup: string;
  /**
   * Lab name: 1-50 letters, digits, `_`, and `-`. If omitted, a unique name
   * is generated from the app, stage, and logical ID. Changing it replaces
   * the lab.
   */
  name?: string;
  /**
   * Azure location of the lab. Changing it replaces the lab.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Storage type of lab VM disks.
   * @default "Premium"
   */
  labStorageType?: "Standard" | "Premium" | "StandardSSD";
  /**
   * Whether lab users may create premium data disks.
   * @default "Disabled"
   */
  premiumDataDisks?: "Enabled" | "Disabled";
  /**
   * Access users get on the resource groups of environments they create.
   * @default "Reader"
   */
  environmentPermission?: "Reader" | "Contributor";
  /** Artifact IDs applied to every new Linux VM, in order. */
  mandatoryArtifactsResourceIdsLinux?: string[];
  /** Artifact IDs applied to every new Windows VM, in order. */
  mandatoryArtifactsResourceIdsWindows?: string[];
  /** Announcement banner shown to lab users. */
  announcement?: LabAnnouncement;
  /** Support banner shown to lab users. */
  support?: LabSupport;
  /** Extended properties for experimental features. */
  extendedProperties?: Record<string, string>;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface Lab extends Resource<
  "Azure.DevTestLabs.Lab",
  LabProps,
  {
    /** Name of the lab. */
    labName: string;
    /** Resource group of the lab. */
    resourceGroup: string;
    /** ARM resource ID of the lab. */
    labId: string;
    /** Location of the lab. */
    location: string;
    /** Unique immutable identifier (GUID) of the lab. */
    uniqueIdentifier: string | undefined;
    /** Storage type of lab VM disks. */
    labStorageType: string | undefined;
    /** Lab's default storage account (ARM ID). */
    defaultStorageAccount: string | undefined;
    /** Lab's default premium storage account (ARM ID). */
    defaultPremiumStorageAccount: string | undefined;
    /** Lab's artifact storage account (ARM ID). */
    artifactsStorageAccount: string | undefined;
    /** Lab's premium data disk storage account (ARM ID). */
    premiumDataDiskStorageAccount: string | undefined;
    /** Lab-owned Key Vault (ARM ID) that stores user secrets. */
    vaultName: string | undefined;
    /** Resource group lab VMs are created in, if fixed. */
    vmCreationResourceGroup: string | undefined;
    /** Public IP of the lab's shared load balancer. */
    publicIpId: string | undefined;
    /** Load balancer for lab VMs that share a public IP. */
    loadBalancerId: string | undefined;
    /** Network security group attached to lab VM network interfaces. */
    networkSecurityGroupId: string | undefined;
    /** Creation time of the lab. */
    createdDate: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure DevTest Lab — a managed workspace that lets teams create
 * self-service VMs and environments under cost, size, and shutdown
 * policies.
 *
 * Creating a lab also creates its storage accounts, Key Vault, and default
 * virtual network; deleting it deletes them and every lab VM.
 *
 * @see https://learn.microsoft.com/azure/devtest-labs/devtest-lab-overview
 *
 * ### Creating a Lab
 * **Example:** Lab with standard storage
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("labs");
 * const lab = yield* Azure.DevTestLabs.Lab("team-lab", {
 *   resourceGroup: group.resourceGroupName,
 *   labStorageType: "Standard",
 * });
 * ```
 *
 * ### Banners
 * **Example:** Announcement for lab users
 * ```typescript
 * const lab = yield* Azure.DevTestLabs.Lab("team-lab", {
 *   resourceGroup: group.resourceGroupName,
 *   announcement: {
 *     title: "Maintenance",
 *     markdown: "VMs restart on **Saturday**.",
 *     enabled: "Enabled",
 *   },
 * });
 * ```
 *
 * @resource
 */
export const Lab = Resource<Lab>("Azure.DevTestLabs.Lab");

const toAttrs = (
  resourceGroup: string,
  name: string,
  lab: devtestlabs.GetLabResponse,
): Lab["Attributes"] => {
  const p = lab.properties ?? {};
  return {
    labName: name,
    resourceGroup,
    labId: lab.id ?? "",
    location: lab.location ?? "",
    uniqueIdentifier: p.uniqueIdentifier,
    labStorageType: p.labStorageType,
    defaultStorageAccount: p.defaultStorageAccount,
    defaultPremiumStorageAccount: p.defaultPremiumStorageAccount,
    artifactsStorageAccount: p.artifactsStorageAccount,
    premiumDataDiskStorageAccount: p.premiumDataDiskStorageAccount,
    vaultName: p.vaultName,
    vmCreationResourceGroup: p.vmCreationResourceGroup,
    publicIpId: p.publicIpId,
    loadBalancerId: p.loadBalancerId,
    networkSecurityGroupId: p.networkSecurityGroupId,
    createdDate: p.createdDate,
    tags: userTags(lab.tags),
  };
};

export const LabProvider = () =>
  Provider.succeed(Lab, {
    stables: ["labName", "resourceGroup", "labId", "location", "uniqueIdentifier"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* devtestlabs
        .ListLabBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListLabBySubscription", page),
          ),
        );
      return (page.value ?? []).flatMap((lab) => {
        const group = resourceGroupOf(lab.id);
        return hasAnyAlchemyTag(lab.tags) &&
          group !== undefined &&
          lab.name !== undefined
          ? [toAttrs(group, lab.name, lab)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        (news.name !== undefined &&
          news.name.toLowerCase() !== output.labName.toLowerCase()) ||
        (news.location !== undefined &&
          news.location.toLowerCase() !== output.location.toLowerCase())
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      if (resourceGroup === undefined) return undefined;
      const name =
        output?.labName ?? olds?.name ?? (yield* createLabResourceName(id));
      const observed = yield* getLab(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, DEVTESTLAB_NAMESPACE);
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ?? output?.labName ?? (yield* createLabResourceName(id));
      const tags = yield* desiredTags(id, news.tags);
      const properties: devtestlabs.LabPropertiesInput = {
        labStorageType: news.labStorageType,
        premiumDataDisks: news.premiumDataDisks,
        environmentPermission: news.environmentPermission,
        mandatoryArtifactsResourceIdsLinux: news.mandatoryArtifactsResourceIdsLinux,
        mandatoryArtifactsResourceIdsWindows:
          news.mandatoryArtifactsResourceIdsWindows,
        announcement: news.announcement,
        support: news.support,
        extendedProperties: news.extendedProperties,
      };
      const get = getLab(subscriptionId, resourceGroup, name);
      const wait = waitForProvisioned(
        `lab ${name}`,
        get,
        (lab) => lab.properties?.provisioningState,
        { interval: "5 seconds", times: 72 },
      );

      // Observe; an in-flight create/update must settle before a PUT.
      let observed = yield* get;
      if (observed !== undefined) observed = yield* wait;

      // Ensure + sync. PUT is a full upsert (long-running); PATCH only
      // updates tags, so any property or tag delta is one PUT.
      if (
        observed === undefined ||
        diverges(properties, observed.properties) ||
        tagsDiffer(observed.tags, tags)
      ) {
        yield* devtestlabs.LabsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          name,
          location:
            observed?.location ?? news.location ?? output?.location ?? env.location,
          tags,
          properties: {
            // Keep observed settings the user did not specify; PUT replaces.
            labStorageType: observed?.properties?.labStorageType,
            premiumDataDisks: observed?.properties?.premiumDataDisks,
            environmentPermission: observed?.properties?.environmentPermission,
            ...Object.fromEntries(
              Object.entries(properties).filter(([, v]) => v !== undefined),
            ),
          },
        });
        observed = yield* wait;
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        devtestlabs.DeleteLab({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          name: output.labName,
        }),
      );
      // Lab delete removes its storage, Key Vault, and VMs: minutes.
      yield* waitUntilGone(
        `lab ${output.labName}`,
        getLab(subscriptionId, output.resourceGroup, output.labName),
        { interval: "10 seconds", times: 90 },
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
