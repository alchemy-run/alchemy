import * as desktopvirtualization from "@distilled.cloud/azure/desktopvirtualization";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
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
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { deltaOf, sameIdSet } from "./Common.ts";

/**
 * Package metadata of an MSIX/App-V image, as returned by the host pool's
 * `importAppAttachPackageInfo` action for the image path.
 */
export type AppAttachPackageImage =
  desktopvirtualization.AppAttachPackageInfoProperties;

export interface AppAttachPackageProps {
  /** Resource group of the package. Changing it replaces the package. */
  resourceGroup: string;
  /**
   * Package name, 3-63 lowercase letters, digits, and single hyphens. If
   * omitted, a unique name is generated from the app, stage, and logical
   * ID. Changing it replaces the package.
   */
  name?: string;
  /**
   * Azure Virtual Desktop metadata location of the package. Changing it
   * replaces the package.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /** Package metadata, including `imagePath` on the file share. */
  image: AppAttachPackageImage;
  /**
   * ARM IDs of the host pools the package is attached to.
   * @default []
   */
  hostPoolIds?: string[];
  /** Key Vault URL of the certificate that signed the package. */
  keyVaultURL?: string;
  /** Health-check behaviour when the package fails to stage on a session host. */
  failHealthCheckOnStagingFailure?:
    | "Unhealthy"
    | "NeedsAssistance"
    | "DoNotFail";
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface AppAttachPackage extends Resource<
  "Azure.DesktopVirtualization.AppAttachPackage",
  AppAttachPackageProps,
  {
    /** Name of the package. */
    appAttachPackageName: string;
    /** ARM resource ID of the package. */
    appAttachPackageId: string;
    /** Resource group of the package. */
    resourceGroup: string;
    /** Metadata location of the package. */
    location: string;
    /** Package family name of the attached image. */
    packageFamilyName: string | undefined;
    /** Version of the attached image. */
    version: string | undefined;
    /** ARM IDs of the host pools the package is attached to. */
    hostPoolIds: string[];
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Virtual Desktop App Attach package — an MSIX or App-V
 * application image on a file share, attached to host pools so session
 * hosts mount it dynamically for users instead of installing it.
 *
 * The session hosts must reach the image path; package metadata (family
 * name, version, applications) normally comes from the host pool's
 * `importAppAttachPackageInfo` action.
 *
 * @see https://learn.microsoft.com/azure/virtual-desktop/app-attach-overview
 *
 * ### Attaching a Package
 * **Example:** Attach an MSIX image to a host pool
 * ```typescript
 * const pkg = yield* Azure.DesktopVirtualization.AppAttachPackage("notepadpp", {
 *   resourceGroup: group.resourceGroupName,
 *   hostPoolIds: [pool.hostPoolId],
 *   failHealthCheckOnStagingFailure: "NeedsAssistance",
 *   image: {
 *     imagePath: "\\\\files.file.core.windows.net\\apps\\notepadpp.cim",
 *     packageName: "NotepadPlusPlus",
 *     packageFamilyName: "NotepadPlusPlus_7xyz",
 *     packageFullName: "NotepadPlusPlus_8.6.0.0_x64__7xyz",
 *     packageRelativePath: "\\NotepadPlusPlus_8.6.0.0_x64__7xyz",
 *     version: "8.6.0.0",
 *     isActive: true,
 *     isRegularRegistration: false,
 *     lastUpdated: "2026-01-01T00:00:00Z",
 *     packageApplications: [],
 *     packageDependencies: [],
 *   },
 * });
 * ```
 *
 * @resource
 */
export const AppAttachPackage = Resource<AppAttachPackage>(
  "Azure.DesktopVirtualization.AppAttachPackage",
);

type ObservedPackage = desktopvirtualization.GetAppAttachPackageResponse;

/** 3-63 lowercase letters, digits, and single hyphens. */
const createPackageName = Effect.fn(function* (id: string) {
  const name = yield* createPhysicalName({
    id,
    maxLength: 63,
    lowercase: true,
  });
  return name
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
});

const getPackage = (
  subscriptionId: string,
  resourceGroupName: string,
  appAttachPackageName: string,
) =>
  orUndefinedIfNotFound(
    desktopvirtualization.GetAppAttachPackage({
      subscriptionId,
      resourceGroupName,
      appAttachPackageName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  pkg: ObservedPackage,
): AppAttachPackage["Attributes"] => ({
  appAttachPackageName: name,
  appAttachPackageId: pkg.id ?? "",
  resourceGroup,
  location: pkg.location,
  packageFamilyName: pkg.properties?.image?.packageFamilyName,
  version: pkg.properties?.image?.version,
  hostPoolIds: pkg.properties?.hostPoolReferences ?? [],
  tags: userTags(pkg.tags),
});

export const AppAttachPackageProvider = () =>
  Provider.succeed(AppAttachPackage, {
    stables: [
      "appAttachPackageName",
      "appAttachPackageId",
      "resourceGroup",
      "location",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* desktopvirtualization
        .ListAppAttachPackageBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListAppAttachPackageBySubscription", page),
          ),
        );
      return (page.value ?? []).flatMap((pkg) => {
        const rg = resourceGroupOf(pkg.id);
        return hasAnyAlchemyTag(pkg.tags) &&
          rg !== undefined &&
          pkg.name !== undefined
          ? [toAttrs(rg, pkg.name, pkg)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        (news.name !== undefined &&
          news.name.toLowerCase() !==
            output.appAttachPackageName.toLowerCase()) ||
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
        output?.appAttachPackageName ??
        olds?.name ??
        (yield* createPackageName(id));
      const observed = yield* getPackage(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(
        subscriptionId,
        "Microsoft.DesktopVirtualization",
      );
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ??
        output?.appAttachPackageName ??
        (yield* createPackageName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const hostPoolReferences = news.hostPoolIds ?? [];
      const desired = {
        image: news.image,
        keyVaultURL: news.keyVaultURL,
        failHealthCheckOnStagingFailure: news.failHealthCheckOnStagingFailure,
      };
      const request = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        appAttachPackageName: name,
      };
      const put = desktopvirtualization.AppAttachPackageCreateOrUpdate({
        ...request,
        location,
        tags,
        properties: { ...desired, hostPoolReferences },
      });

      // Observe.
      let observed: ObservedPackage | undefined = yield* getPackage(
        subscriptionId,
        resourceGroup,
        name,
      );

      if (observed === undefined || tagsDiffer(observed.tags, tags)) {
        // Ensure, or sync tags: PATCH cannot change tags, so a full PUT
        // (synchronous) covers both.
        observed = yield* put;
      } else {
        // Sync: PATCH only the observed deltas.
        const delta = deltaOf(desired, observed.properties);
        const referencesChanged = !sameIdSet(
          observed.properties?.hostPoolReferences,
          hostPoolReferences,
        );
        if (delta !== undefined || referencesChanged) {
          observed = yield* desktopvirtualization.UpdateAppAttachPackage({
            ...request,
            properties: {
              ...delta,
              ...(referencesChanged ? { hostPoolReferences } : {}),
            },
          });
        }
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        desktopvirtualization.DeleteAppAttachPackage({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          appAttachPackageName: output.appAttachPackageName,
        }),
      );
      yield* waitUntilGone(
        `app attach package ${output.appAttachPackageName}`,
        getPackage(
          subscriptionId,
          output.resourceGroup,
          output.appAttachPackageName,
        ),
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.DesktopVirtualization.HostPool",
        "Azure.Resources.ResourceGroup",
      ],
    },
  });
