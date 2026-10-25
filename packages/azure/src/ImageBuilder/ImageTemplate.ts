import * as imagebuilder from "@distilled.cloud/azure/imagebuilder";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import {
  collectAll,
  desiredTags,
  ensureRegistered,
  hasAnyAlchemyTag,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  ProvisioningFailed,
  resourceGroupOf,
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";

/** Marketplace plan of a platform image that requires one. */
export interface ImageTemplatePlanInfo {
  /** Plan name. */
  planName: string;
  /** Plan product. */
  planProduct: string;
  /** Plan publisher. */
  planPublisher: string;
}

/** Image the build starts from. */
export type ImageTemplateSource =
  | {
      /** An Azure Marketplace platform image. */
      type: "PlatformImage";
      /** Image publisher, e.g. `Canonical`. */
      publisher: string;
      /** Image offer, e.g. `ubuntu-24_04-lts`. */
      offer: string;
      /** Image SKU, e.g. `server`. */
      sku: string;
      /** Image version, or `latest`. */
      version: string;
      /**
       * Marketplace purchase plan, for images that require one.
       * @default unset
       */
      planInfo?: ImageTemplatePlanInfo;
    }
  | {
      /** An existing managed image. */
      type: "ManagedImage";
      /** ARM ID of the managed image. */
      imageId: string;
    }
  | {
      /** A version of an Azure Compute Gallery image. */
      type: "SharedImageVersion";
      /**
       * ARM ID of the gallery image version. Use `.../versions/latest` to
       * enable a `SourceImage` trigger.
       */
      imageVersionId: string;
    };

/** One customization step run on the build VM. */
export type ImageTemplateCustomizer =
  | {
      /** Run a shell script (Linux). */
      type: "Shell";
      /**
       * Friendly name of the step.
       * @default unset
       */
      name?: string;
      /**
       * URI of the script to run.
       * @default unset
       */
      scriptUri?: string;
      /**
       * SHA256 checksum of the script at `scriptUri`.
       * @default unset (the download is not verified)
       */
      sha256Checksum?: string;
      /**
       * Inline commands to run.
       * @default []
       */
      inline?: string[];
    }
  | {
      /** Run a PowerShell script (Windows). */
      type: "PowerShell";
      /**
       * Friendly name of the step.
       * @default unset
       */
      name?: string;
      /**
       * URI of the script to run.
       * @default unset
       */
      scriptUri?: string;
      /**
       * SHA256 checksum of the script at `scriptUri`.
       * @default unset (the download is not verified)
       */
      sha256Checksum?: string;
      /**
       * Inline commands to run.
       * @default []
       */
      inline?: string[];
      /** Exit codes that count as success. @default [0] */
      validExitCodes?: number[];
      /**
       * Run with elevated privileges.
       * @default false
       */
      runElevated?: boolean;
      /**
       * Run as the Local System user (requires `runElevated`).
       * @default false
       */
      runAsSystem?: boolean;
    }
  | {
      /** Restart a Windows build VM. */
      type: "WindowsRestart";
      /**
       * Friendly name of the step.
       * @default unset
       */
      name?: string;
      /**
       * Command that performs the restart.
       * @default Azure's default restart command
       */
      restartCommand?: string;
      /**
       * Command that checks the restart succeeded.
       * @default unset
       */
      restartCheckCommand?: string;
      /**
       * Restart timeout, e.g. `5m` or `2h`.
       * @default "5m"
       */
      restartTimeout?: string;
    }
  | {
      /** Install Windows updates. */
      type: "WindowsUpdate";
      /**
       * Friendly name of the step.
       * @default unset
       */
      name?: string;
      /**
       * Update search criteria.
       * @default Azure's default search criteria
       */
      searchCriteria?: string;
      /**
       * Update filters.
       * @default []
       */
      filters?: string[];
      /**
       * Maximum number of updates applied at a time.
       * @default Azure's default
       */
      updateLimit?: number;
    }
  | {
      /** Download a file to the build VM. */
      type: "File";
      /**
       * Friendly name of the step.
       * @default unset
       */
      name?: string;
      /**
       * URI of the file to download.
       * @default unset
       */
      sourceUri?: string;
      /**
       * SHA256 checksum of the file.
       * @default unset (the download is not verified)
       */
      sha256Checksum?: string;
      /**
       * Absolute destination path on the build VM.
       * @default unset
       */
      destination?: string;
    };

/** One in-VM validation step run on the resulting image. */
export type ImageTemplateValidator =
  | {
      /** Validate with a shell script (Linux). */
      type: "Shell";
      /**
       * Friendly name of the step.
       * @default unset
       */
      name?: string;
      /**
       * URI of the script to run.
       * @default unset
       */
      scriptUri?: string;
      /**
       * SHA256 checksum of the script.
       * @default unset (the download is not verified)
       */
      sha256Checksum?: string;
      /**
       * Inline commands to run.
       * @default []
       */
      inline?: string[];
    }
  | {
      /** Validate with a PowerShell script (Windows). */
      type: "PowerShell";
      /**
       * Friendly name of the step.
       * @default unset
       */
      name?: string;
      /**
       * URI of the script to run.
       * @default unset
       */
      scriptUri?: string;
      /**
       * SHA256 checksum of the script.
       * @default unset (the download is not verified)
       */
      sha256Checksum?: string;
      /**
       * Inline commands to run.
       * @default []
       */
      inline?: string[];
      /**
       * Exit codes that count as success.
       * @default [0]
       */
      validExitCodes?: number[];
      /**
       * Run with elevated privileges.
       * @default false
       */
      runElevated?: boolean;
      /**
       * Run as the Local System user.
       * @default false
       */
      runAsSystem?: boolean;
    }
  | {
      /** Download a file to the validation VM. */
      type: "File";
      /**
       * Friendly name of the step.
       * @default unset
       */
      name?: string;
      /**
       * URI of the file to download.
       * @default unset
       */
      sourceUri?: string;
      /**
       * SHA256 checksum of the file.
       * @default unset (the download is not verified)
       */
      sha256Checksum?: string;
      /**
       * Absolute destination path.
       * @default unset
       */
      destination?: string;
    };

/** Where a built image is published. */
export type ImageTemplateDistributor =
  | {
      /** Publish as a managed image. */
      type: "ManagedImage";
      /** Name of the run output that records this distribution. */
      runOutputName: string;
      /** ARM ID of the managed image to create. */
      imageId: string;
      /** Azure location of the managed image. */
      location: string;
      /**
       * Tags applied to the created image.
       * @default {}
       */
      artifactTags?: Record<string, string>;
    }
  | {
      /** Publish as an Azure Compute Gallery image version. */
      type: "SharedImage";
      /** Name of the run output that records this distribution. */
      runOutputName: string;
      /** ARM ID of the gallery image definition (or a specific version). */
      galleryImageId: string;
      /**
       * Target regions with replica counts and storage types.
       * @default unset
       */
      targetRegions?: {
        /** Azure region to replicate the version to. Required. */
        name: string;
        /**
         * Number of replicas in the region.
         * @default Azure's default
         */
        replicaCount?: number;
        /**
         * Storage type of the replicas.
         * @default Azure's default
         */
        storageAccountType?: "Standard_LRS" | "Standard_ZRS" | "Premium_LRS";
      }[];
      /**
       * Exclude the version from `latest`.
       * @default false
       */
      excludeFromLatest?: boolean;
      /**
       * Tags applied to the created image version.
       * @default {}
       */
      artifactTags?: Record<string, string>;
    }
  | {
      /** Publish as a VHD in a storage account. */
      type: "VHD";
      /** Name of the run output that records this distribution. */
      runOutputName: string;
      /**
       * Destination blob URI; the service picks one when omitted.
       * @default a blob URI the service picks
       */
      uri?: string;
      /**
       * Tags applied to the created artifact.
       * @default {}
       */
      artifactTags?: Record<string, string>;
    };

/** The build (and validation) VM. */
export interface ImageTemplateVmProfile {
  /**
   * VM size of the build VM.
   * @default "" (`Standard_D2ds_v4` for Gen2 images, `Standard_D1_v2` for Gen1)
   */
  vmSize?: string;
  /**
   * OS disk size in GB; `0` uses the image default.
   * @default 0
   */
  osDiskSizeGB?: number;
  /**
   * ARM IDs of user-assigned identities attached to the build VM.
   * @default []
   */
  userAssignedIdentities?: string[];
  /**
   * Virtual network the build VM is deployed into.
   * @default unset (Image Builder deploys its own network)
   */
  vnetConfig?: {
    /**
     * Subnet ID for the build VM.
     * @default unset
     */
    subnetId?: string;
    /**
     * Subnet ID for Azure Container Instance (isolated builds).
     * @default unset
     */
    containerInstanceSubnetId?: string;
    /**
     * Size of the proxy VM.
     * @default Azure's default proxy VM size
     */
    proxyVmSize?: string;
  };
}

export interface ImageTemplateProps {
  /**
   * Resource group the template is created in. Changing it replaces the
   * template.
   * @default the stack's resource group (`Azure.resourceGroup(...)`, else `<stack>-<stage>`)
   */
  resourceGroup: string;
  /**
   * Name of the template, up to 64 letters, digits, `-`, `_` and `.`. If
   * omitted, a unique name is generated from the app, stage, and logical ID.
   * Changing it replaces the template.
   * @default a unique name generated from the app, stage, and logical ID
   */
  name?: string;
  /**
   * Azure location of the template. Changing it replaces the template.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * ARM ID of the user-assigned identity Image Builder runs as. It needs
   * rights on the distribution targets (and on a custom staging resource
   * group). Mutable in place.
   */
  identityId: string;
  /** Image the build starts from. Changing it replaces the template. */
  source: ImageTemplateSource;
  /**
   * Customization steps, in order. Changing them replaces the template.
   * @default []
   */
  customize?: ImageTemplateCustomizer[];
  /** Where the built image is published. Mutable in place. */
  distribute: ImageTemplateDistributor[];
  /**
   * Optimize the image for faster VM boot. Changing it replaces the
   * template.
   * @default false
   */
  optimizeVmBoot?: boolean;
  /**
   * In-VM validation of the built image. Changing it replaces the template.
   * @default no validation
   */
  validate?: {
    /**
     * Validations to run.
     * @default []
     */
    inVMValidations?: ImageTemplateValidator[];
    /** Distribute even when validation fails. @default false */
    continueDistributeOnFailure?: boolean;
    /** Only validate the source image, without customizing. @default false */
    sourceValidationOnly?: boolean;
  };
  /**
   * Cleanup behaviour after a failed build. Changing it replaces the template.
   * @default Azure's default
   */
  errorHandling?: {
    /**
     * `cleanup` or `abort` the build VM after a customizer error.
     * @default Azure's default
     */
    onCustomizerError?: "cleanup" | "abort";
    /**
     * `cleanup` or `abort` the build VM after a validation error.
     * @default Azure's default
     */
    onValidationError?: "cleanup" | "abort";
  };
  /**
   * Maximum build duration in minutes; `0` means 4 hours. Changing it
   * replaces the template.
   * @default 0
   */
  buildTimeoutInMinutes?: number;
  /**
   * Build VM settings. Mutable in place.
   * @default Azure's default build VM
   */
  vmProfile?: ImageTemplateVmProfile;
  /**
   * Additional data disks (sizes in GB). Changing them replaces the template.
   * @default []
   */
  additionalDataDisks?: number[];
  /**
   * ARM ID of the staging resource group. If omitted, Image Builder creates
   * an `IT_*` group and deletes it with the template. Changing it replaces
   * the template.
   * @default an `IT_*` group Image Builder creates
   */
  stagingResourceGroup?: string;
  /**
   * Start a build automatically when the template is created. Changing it
   * replaces the template.
   * @default false
   */
  autoRun?: boolean;
  /**
   * Tags on the staging resource group and the resources Image Builder
   * creates. Changing them replaces the template.
   * @default {}
   */
  managedResourceTags?: Record<string, string>;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   * @default {}
   */
  tags?: Record<string, string>;
}

export interface ImageTemplate extends Resource<
  "Azure.ImageBuilder.ImageTemplate",
  ImageTemplateProps,
  {
    /** Name of the template. */
    imageTemplateName: string;
    /** Resource group that holds the template. */
    resourceGroup: string;
    /** ARM resource ID of the template. */
    imageTemplateId: string;
    /** Location of the template. */
    location: string;
    /** Provisioning state of the template (`Succeeded` once usable). */
    provisioningState: string;
    /** ARM ID of the staging resource group Image Builder uses. */
    exactStagingResourceGroup: string | undefined;
    /** State of the current or last build (`Running`, `Succeeded`, ...). */
    lastRunState: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure VM Image Builder template
 * (`Microsoft.VirtualMachineImages/imageTemplates`): a declarative
 * description of a source image, customization steps, and distribution
 * targets. Creating the template does not build an image. Start a build
 * with `autoRun`, the `run` action, or a {@link Trigger}.
 *
 * @see https://learn.microsoft.com/azure/virtual-machines/image-builder-overview
 *
 * ### Creating a Template
 * **Example:** Ubuntu image with a shell customizer, published as a managed image
 * ```typescript
 * const groupId =
 *   "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/images";
 * const identity = yield* Azure.ManagedIdentity.UserAssignedIdentity("builder");
 * yield* Azure.Authorization.RoleAssignment("builder-contributor", {
 *   scope: groupId,
 *   roleDefinitionId: Azure.Authorization.BuiltInRole.Contributor,
 *   principalId: identity.principalId,
 *   principalType: "ServicePrincipal",
 * });
 * const template = yield* Azure.ImageBuilder.ImageTemplate("web", {
 *   identityId: identity.identityId,
 *   source: {
 *     type: "PlatformImage",
 *     publisher: "Canonical",
 *     offer: "ubuntu-24_04-lts",
 *     sku: "server",
 *     version: "latest",
 *   },
 *   customize: [
 *     { type: "Shell", name: "install-nginx", inline: ["sudo apt-get install -y nginx"] },
 *   ],
 *   distribute: [
 *     {
 *       type: "ManagedImage",
 *       runOutputName: "web",
 *       imageId: `${groupId}/providers/Microsoft.Compute/images/web`,
 *       location: "eastus",
 *     },
 *   ],
 * });
 * ```
 *
 * ### Building on Create
 * **Example:** Start a build as soon as the template exists
 * ```typescript
 * // identity, source, and distribute as in the example above
 * const template = yield* Azure.ImageBuilder.ImageTemplate("web", {
 *   identityId: identity.identityId,
 *   source,
 *   distribute,
 *   autoRun: true,
 *   vmProfile: { vmSize: "Standard_D2ds_v4", osDiskSizeGB: 64 },
 * });
 * ```
 *
 * :::caution
 * Grant the template's identity rights on the distribution targets (and on
 * a custom `stagingResourceGroup`) before the first build. Without them the
 * build fails.
 * :::
 *
 * :::caution
 * Changing `name`, `location`, `resourceGroup`, `source`, `customize`,
 * `optimizeVmBoot`, `validate`, `errorHandling`, `buildTimeoutInMinutes`,
 * `additionalDataDisks`, `stagingResourceGroup`, `autoRun`, or
 * `managedResourceTags` replaces the template. `identityId`, `distribute`,
 * `vmProfile`, and `tags` update in place.
 * :::
 *
 * @resource
 */
export const ImageTemplate = GroupedResource<ImageTemplate>("Azure.ImageBuilder.ImageTemplate");

type Observed = imagebuilder.GetVirtualMachineImageTemplateResponse;

const NAMESPACE = "Microsoft.VirtualMachineImages";

const sameId = (a: string | undefined, b: string | undefined) =>
  (a ?? "").toLowerCase() === (b ?? "").toLowerCase();

/** Sorted-key JSON, so prop order never registers as a change. */
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, v) =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>)
            .filter(([, x]) => x !== undefined)
            .sort(([a], [b]) => a.localeCompare(b)),
        )
      : v,
  );

/**
 * Every desired field matches the observed value (strings compared
 * case-insensitively — Azure normalizes ARM IDs and locations). Fields
 * Azure adds on read are ignored.
 */
const covers = (desired: unknown, observed: unknown): boolean => {
  if (desired === undefined) return true;
  if (typeof desired === "string") {
    return typeof observed === "string" && sameId(desired, observed);
  }
  if (Array.isArray(desired)) {
    return (
      Array.isArray(observed) &&
      desired.length === observed.length &&
      desired.every((d, i) => covers(d, observed[i]))
    );
  }
  if (desired !== null && typeof desired === "object") {
    if (observed === null || typeof observed !== "object") return false;
    return Object.entries(desired as Record<string, unknown>).every(([k, v]) =>
      covers(v, (observed as Record<string, unknown>)[k]),
    );
  }
  return desired === observed;
};

/** The template content Azure refuses to update in place. */
const immutableKey = (props: ImageTemplateProps) =>
  canonical({
    source: props.source,
    customize: props.customize ?? [],
    optimizeVmBoot: props.optimizeVmBoot ?? false,
    validate: props.validate,
    errorHandling: props.errorHandling,
    buildTimeoutInMinutes: props.buildTimeoutInMinutes ?? 0,
    additionalDataDisks: props.additionalDataDisks ?? [],
    stagingResourceGroup: props.stagingResourceGroup?.toLowerCase(),
    autoRun: props.autoRun ?? false,
    managedResourceTags: props.managedResourceTags ?? {},
  });

const toSdkDistribute = (distribute: ImageTemplateDistributor[]) =>
  distribute as imagebuilder.ImageTemplateDistributor[];

const toSdkVmProfile = (
  vmProfile: ImageTemplateVmProfile | undefined,
): imagebuilder.ImageTemplateVmProfile | undefined => vmProfile;

const identityOf = (identityId: string) => ({
  type: "UserAssigned" as const,
  userAssignedIdentities: { [identityId]: {} },
});

const getTemplate = (
  subscriptionId: string,
  resourceGroupName: string,
  imageTemplateName: string,
) =>
  orUndefinedIfNotFound(
    imagebuilder.GetVirtualMachineImageTemplate({
      subscriptionId,
      resourceGroupName,
      imageTemplateName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  observed: Pick<Observed, "id" | "location" | "properties" | "tags">,
): ImageTemplate["Attributes"] => ({
  imageTemplateName: name,
  resourceGroup,
  imageTemplateId: observed.id ?? "",
  location: observed.location,
  provisioningState: observed.properties?.provisioningState ?? "Succeeded",
  exactStagingResourceGroup: observed.properties?.exactStagingResourceGroup,
  lastRunState: observed.properties?.lastRunStatus?.runState,
  tags: userTags(observed.tags),
});

const templateName = (id: string) => createPhysicalName({ id, maxLength: 64 });

/** Delete a template and wait until it is gone (the staging RG goes with it). */
const deleteTemplate = (
  subscriptionId: string,
  resourceGroupName: string,
  imageTemplateName: string,
) =>
  Effect.gen(function* () {
    const where = { subscriptionId, resourceGroupName, imageTemplateName };
    const observed = yield* getTemplate(subscriptionId, resourceGroupName, imageTemplateName);
    if (observed === undefined) return;
    if (observed.properties?.lastRunStatus?.runState === "Running") {
      yield* ignoreNotFound(imagebuilder.CancelVirtualMachineImageTemplate(where));
      yield* getTemplate(subscriptionId, resourceGroupName, imageTemplateName).pipe(
        Effect.repeat({
          until: (t) => t?.properties?.lastRunStatus?.runState !== "Running",
          schedule: Schedule.spaced("10 seconds"),
          times: 60,
        }),
      );
    }
    yield* ignoreNotFound(imagebuilder.DeleteVirtualMachineImageTemplate(where));
    // Deleting the staging resource group takes several minutes.
    yield* waitUntilGone(
      `image template ${imageTemplateName}`,
      getTemplate(subscriptionId, resourceGroupName, imageTemplateName),
      { interval: "10 seconds", times: 90 },
    );
  });

export const ImageTemplateProvider = () =>
  Provider.succeed(ImageTemplate, {
    stables: ["imageTemplateName", "resourceGroup", "imageTemplateId", "location"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* collectAll(imagebuilder.ListVirtualMachineImageTemplates, {
        subscriptionId,
      });
      return (page.value ?? []).flatMap((template) => {
        const group = resourceGroupOf(template.id);
        return hasAnyAlchemyTag(template.tags) && group !== undefined && template.name !== undefined
          ? [toAttrs(group, template.name, template)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameId(news.resourceGroup, output.resourceGroup) ||
        (news.name !== undefined && !sameId(news.name, output.imageTemplateName)) ||
        (news.location !== undefined && !sameId(news.location, output.location)) ||
        (olds !== undefined && immutableKey(news) !== immutableKey(olds))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      if (resourceGroup === undefined) return undefined;
      const name = output?.imageTemplateName ?? olds?.name ?? (yield* templateName(id));
      const observed = yield* getTemplate(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, NAMESPACE);
      const resourceGroup = news.resourceGroup;
      const name = news.name ?? output?.imageTemplateName ?? (yield* templateName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        imageTemplateName: name,
      };
      const get = getTemplate(subscriptionId, resourceGroup, name);
      // A failed template carries the reason in `provisioningError`.
      const waitReady = waitForProvisioned(
        `image template ${name}`,
        get,
        (t) => t.properties?.provisioningState,
        { interval: "5 seconds", times: 120 },
      ).pipe(
        Effect.catchTag("Azure.ProvisioningFailed", (failure) =>
          get.pipe(
            Effect.flatMap((t) => {
              const error = t?.properties?.provisioningError;
              return Effect.fail(
                error === undefined
                  ? failure
                  : new ProvisioningFailed({
                      resource: failure.resource,
                      state: failure.state,
                      message: `${failure.message}: ${error.provisioningErrorCode ?? "Error"}: ${error.message ?? ""}`,
                    }),
              );
            }),
          ),
        ),
      );

      // Observe.
      let observed = yield* get;

      // A template whose creation failed cannot be repaired in place.
      if (observed?.properties?.provisioningState === "Failed") {
        yield* deleteTemplate(subscriptionId, resourceGroup, name);
        observed = undefined;
      }

      // Ensure. Template content is immutable, so PUT only when missing.
      if (observed === undefined) {
        yield* imagebuilder.VirtualMachineImageTemplatesCreateOrUpdate({
          ...where,
          location,
          tags,
          identity: identityOf(news.identityId),
          properties: {
            source: news.source as imagebuilder.ImageTemplateSource,
            customize: news.customize as imagebuilder.ImageTemplateCustomizer[] | undefined,
            optimize:
              news.optimizeVmBoot === undefined
                ? undefined
                : {
                    vmBoot: {
                      state: news.optimizeVmBoot ? "Enabled" : "Disabled",
                    },
                  },
            validate: news.validate as imagebuilder.ImageTemplatePropertiesValidate | undefined,
            distribute: toSdkDistribute(news.distribute),
            errorHandling: news.errorHandling,
            buildTimeoutInMinutes: news.buildTimeoutInMinutes,
            vmProfile: toSdkVmProfile(news.vmProfile),
            additionalDataDisks: news.additionalDataDisks?.map((sizeGB) => ({
              sizeGB,
            })),
            stagingResourceGroup: news.stagingResourceGroup,
            autoRun: {
              state: news.autoRun ? "Enabled" : "Disabled",
            },
            managedResourceTags: news.managedResourceTags,
          },
        });
        observed = yield* waitReady;
      }

      // Sync the mutable aspects against observed state.
      const observedIdentities = Object.keys(observed.identity?.userAssignedIdentities ?? {});
      const identityDrift =
        observedIdentities.length !== 1 || !sameId(observedIdentities[0], news.identityId);
      const distributeDrift = !covers(news.distribute, observed.properties?.distribute ?? []);
      const vmProfileDrift = !covers(news.vmProfile ?? {}, observed.properties?.vmProfile ?? {});
      const tagDrift = tagsDiffer(observed.tags, tags);
      if (identityDrift || distributeDrift || vmProfileDrift || tagDrift) {
        yield* imagebuilder.UpdateVirtualMachineImageTemplate({
          ...where,
          identity: identityDrift ? identityOf(news.identityId) : undefined,
          tags: tagDrift ? tags : undefined,
          properties:
            distributeDrift || vmProfileDrift
              ? {
                  distribute: distributeDrift ? toSdkDistribute(news.distribute) : undefined,
                  vmProfile: vmProfileDrift ? toSdkVmProfile(news.vmProfile ?? {}) : undefined,
                }
              : undefined,
        });
        observed = yield* waitReady;
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* deleteTemplate(subscriptionId, output.resourceGroup, output.imageTemplateName);
    }),

    nuke: {
      dependsOn: ["Azure.Resources.ResourceGroup", "Azure.ManagedIdentity.UserAssignedIdentity"],
    },
  });
