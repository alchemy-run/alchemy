import * as desktopvirtualization from "@distilled.cloud/azure/desktopvirtualization";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { ensureRegistered, ignoreNotFound, orUndefinedIfNotFound, waitUntilGone } from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";
import { deltaOf, ownedByStage } from "./Common.ts";
import { getHostPool } from "./HostPool.ts";

/** An application inside an MSIX package, from its `appxmanifest.xml`. */
export type MsixPackageApplication = desktopvirtualization.MsixPackageApplications;

/** A package the MSIX package depends on, from its `appxmanifest.xml`. */
export type MsixPackageDependency = desktopvirtualization.MsixPackageDependencies;

export interface MsixPackageProps {
  /**
   * Resource group of the host pool.
   *
   * :::caution
   * Changing it replaces the package.
   * :::
   */
  resourceGroup: string;
  /**
   * Name of the host pool the package is added to.
   *
   * :::caution
   * Changing it replaces the package.
   * :::
   */
  hostPool: string;
  /**
   * Version-specific package full name from `appxmanifest.xml`, e.g.
   * `NotepadPlusPlus_8.6.0.0_x64__7njy0v32s6xk6`. It is the resource name.
   *
   * :::caution
   * Changing it replaces the package.
   * :::
   */
  packageFullName: string;
  /**
   * VHD or CIM image path on the file share the session hosts mount.
   *
   * :::caution
   * Changing it replaces the package.
   * :::
   */
  imagePath: string;
  /**
   * Package name from `appxmanifest.xml`.
   *
   * :::caution
   * Changing it replaces the package.
   * :::
   */
  packageName: string;
  /**
   * Package family name from `appxmanifest.xml` (package name + publisher).
   *
   * :::caution
   * Changing it replaces the package.
   * :::
   */
  packageFamilyName: string;
  /**
   * Path of the package inside the image, e.g.
   * `\\NotepadPlusPlus_8.6.0.0_x64__7njy0v32s6xk6`.
   *
   * :::caution
   * Changing it replaces the package.
   * :::
   */
  packageRelativePath: string;
  /**
   * Package version from `appxmanifest.xml`.
   *
   * :::caution
   * Changing it replaces the package.
   * :::
   */
  version: string;
  /**
   * When the package was last updated, from `appxmanifest.xml` (ISO 8601).
   *
   * :::caution
   * Changing it replaces the package.
   * :::
   */
  lastUpdated: string;
  /** Name shown in the Azure portal. */
  displayName?: string;
  /**
   * Make this version the active one across the host pool.
   * @default true
   */
  isActive?: boolean;
  /**
   * Register the package at sign-in (`true`) instead of on first launch
   * (`false`, delayed registration).
   * @default false
   */
  isRegularRegistration?: boolean;
  /**
   * Applications in the package. Azure requires `iconImageName`, `rawIcon`,
   * and `rawPng` (base64) on each one.
   * @default []
   *
   * :::caution
   * Changing it replaces the package.
   * :::
   */
  packageApplications?: MsixPackageApplication[];
  /**
   * Packages this package depends on.
   * @default []
   *
   * :::caution
   * Changing it replaces the package.
   * :::
   */
  packageDependencies?: MsixPackageDependency[];
}

export interface MsixPackage extends Resource<
  "Azure.DesktopVirtualization.MsixPackage",
  MsixPackageProps,
  {
    /** Version-specific package full name (the resource name). */
    packageFullName: string;
    /** ARM resource ID of the package. */
    msixPackageId: string;
    /** Resource group of the host pool. */
    resourceGroup: string;
    /** Name of the host pool. */
    hostPool: string;
    /** Package family name. */
    packageFamilyName: string | undefined;
    /** Package version. */
    version: string | undefined;
    /** Whether this version is the active one across the host pool. */
    isActive: boolean | undefined;
    /** Name shown in the Azure portal. */
    displayName: string | undefined;
    /** When the package was last updated, from `appxmanifest.xml`. */
    lastUpdated: string | undefined;
  },
  never,
  Providers
> {}

/**
 * An MSIX package added to an Azure Virtual Desktop host pool
 * (`Microsoft.DesktopVirtualization/hostPools/msixPackages`) — the
 * per-host-pool form of MSIX app attach. Session hosts of the pool mount
 * the image from the file share and register the package for users.
 *
 * The package metadata (full name, family name, relative path, version,
 * applications) normally comes from the host pool's `expandMsixImage`
 * action for the image path. For packages shared across host pools, use
 * `AppAttachPackage` instead.
 *
 * Azure rejects changes to the image metadata, so changing any of it
 * replaces the package; only `displayName`, `isActive`, and
 * `isRegularRegistration` update in place.
 *
 * MSIX packages have no tags; Alchemy treats a package as owned when its
 * host pool carries this stack's ownership tags.
 *
 * @see https://learn.microsoft.com/azure/virtual-desktop/app-attach-setup
 *
 * ### Adding a Package
 * **Example:** Add an MSIX image to a host pool
 * ```typescript
 * const notepad = yield* Azure.DesktopVirtualization.MsixPackage("notepadpp", {
 *   hostPool: pool.hostPoolName,
 *   packageFullName: "NotepadPlusPlus_8.6.0.0_x64__7njy0v32s6xk6",
 *   imagePath: "\\\\files.file.core.windows.net\\apps\\notepadpp.cim",
 *   packageName: "NotepadPlusPlus",
 *   packageFamilyName: "NotepadPlusPlus_7njy0v32s6xk6",
 *   packageRelativePath: "\\NotepadPlusPlus_8.6.0.0_x64__7njy0v32s6xk6",
 *   version: "8.6.0.0",
 *   lastUpdated: "2026-01-01T00:00:00Z",
 *   displayName: "Notepad++",
 * });
 * ```
 *
 * **Example:** Stage a package without making it active
 * ```typescript
 * yield* Azure.DesktopVirtualization.MsixPackage("notepadpp-next", {
 *   hostPool: pool.hostPoolName,
 *   packageFullName: "NotepadPlusPlus_8.7.0.0_x64__7njy0v32s6xk6",
 *   imagePath: "\\\\files.file.core.windows.net\\apps\\notepadpp-8.7.cim",
 *   packageName: "NotepadPlusPlus",
 *   packageFamilyName: "NotepadPlusPlus_7njy0v32s6xk6",
 *   packageRelativePath: "\\NotepadPlusPlus_8.7.0.0_x64__7njy0v32s6xk6",
 *   version: "8.7.0.0",
 *   lastUpdated: "2026-03-01T00:00:00Z",
 *   isActive: false,
 * });
 * ```
 *
 * @resource
 */
export const MsixPackage = GroupedResource<MsixPackage>("Azure.DesktopVirtualization.MsixPackage");

type ObservedPackage = desktopvirtualization.GetMSIXPackageResponse;

const getPackage = (
  subscriptionId: string,
  resourceGroupName: string,
  hostPoolName: string,
  msixPackageFullName: string,
) =>
  orUndefinedIfNotFound(
    desktopvirtualization.GetMSIXPackage({
      subscriptionId,
      resourceGroupName,
      hostPoolName,
      msixPackageFullName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  hostPool: string,
  packageFullName: string,
  pkg: ObservedPackage,
): MsixPackage["Attributes"] => ({
  packageFullName,
  msixPackageId: pkg.id ?? "",
  resourceGroup,
  hostPool,
  packageFamilyName: pkg.properties?.packageFamilyName,
  version: pkg.properties?.version,
  isActive: pkg.properties?.isActive,
  displayName: pkg.properties?.displayName ?? undefined,
  lastUpdated: pkg.properties?.lastUpdated,
});

/** Epoch millis of an ISO 8601 timestamp; one without a zone is UTC. */
const instantOf = (timestamp: string) =>
  Date.parse(/(Z|[+-]\d{2}:?\d{2})$/i.test(timestamp) ? timestamp : `${timestamp}Z`);

/** Same instant; Azure echoes timestamps without the zone designator. */
const sameInstant = (a: string | undefined, b: string | undefined) =>
  a !== undefined && b !== undefined && instantOf(a) === instantOf(b);

/** Image metadata: set by the PUT, immutable afterwards. */
const imageProperties = (news: MsixPackageProps) => ({
  imagePath: news.imagePath,
  packageName: news.packageName,
  packageFamilyName: news.packageFamilyName,
  packageRelativePath: news.packageRelativePath,
  version: news.version,
  packageApplications: news.packageApplications ?? [],
  packageDependencies: news.packageDependencies ?? [],
});

/** Properties the PATCH accepts. */
const patchableProperties = (news: MsixPackageProps) => ({
  displayName: news.displayName,
  isActive: news.isActive ?? true,
  isRegularRegistration: news.isRegularRegistration ?? false,
});

export const MsixPackageProvider = () =>
  Provider.succeed(MsixPackage, {
    stables: ["packageFullName", "msixPackageId", "resourceGroup", "hostPool"],

    // MSIX packages are removed with their host pool.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      const moved =
        news.resourceGroup.toLowerCase() !== output.resourceGroup.toLowerCase() ||
        news.hostPool.toLowerCase() !== output.hostPool.toLowerCase() ||
        news.packageFullName.toLowerCase() !== output.packageFullName.toLowerCase();
      if (moved) return { action: "replace" } as const;
      // Azure rejects changes to the image metadata ("Cannot update
      // ImagePath", "Cannot Update Last Updated"). Same name: the old
      // package must go before the new one is created.
      const restamped =
        output.lastUpdated !== undefined && !sameInstant(news.lastUpdated, output.lastUpdated);
      const reimaged =
        olds !== undefined && deltaOf(imageProperties(news), imageProperties(olds)) !== undefined;
      if (restamped || reimaged) return { action: "replace", deleteFirst: true } as const;
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const hostPool = output?.hostPool ?? olds?.hostPool;
      const packageFullName = output?.packageFullName ?? olds?.packageFullName;
      // An interrupted create can persist props with unresolved holes.
      if (resourceGroup === undefined || hostPool === undefined || packageFullName === undefined) {
        return undefined;
      }
      const observed = yield* getPackage(subscriptionId, resourceGroup, hostPool, packageFullName);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, hostPool, packageFullName, observed);
      const parent = yield* getHostPool(subscriptionId, resourceGroup, hostPool);
      return (yield* ownedByStage(parent?.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.DesktopVirtualization");
      const { resourceGroup, hostPool, packageFullName } = news;
      const patchable = patchableProperties(news);
      const request = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        hostPoolName: hostPool,
        msixPackageFullName: packageFullName,
      };

      // Observe.
      let observed: ObservedPackage | undefined = yield* getPackage(
        subscriptionId,
        resourceGroup,
        hostPool,
        packageFullName,
      );

      if (observed === undefined) {
        // Ensure: the PUT (synchronous) sets the immutable image metadata.
        observed = yield* desktopvirtualization.MSIXPackagesCreateOrUpdate({
          ...request,
          properties: { ...imageProperties(news), ...patchable, lastUpdated: news.lastUpdated },
        });
      } else {
        // Sync: PATCH only the observed deltas.
        const delta = deltaOf(patchable, observed.properties);
        if (delta !== undefined) {
          observed = yield* desktopvirtualization.UpdateMSIXPackage({
            ...request,
            properties: delta,
          });
        }
      }

      return toAttrs(resourceGroup, hostPool, packageFullName, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        desktopvirtualization.DeleteMSIXPackage({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          hostPoolName: output.hostPool,
          msixPackageFullName: output.packageFullName,
        }),
      );
      yield* waitUntilGone(
        `MSIX package ${output.hostPool}/${output.packageFullName}`,
        getPackage(subscriptionId, output.resourceGroup, output.hostPool, output.packageFullName),
      );
    }),

    nuke: {
      dependsOn: ["Azure.DesktopVirtualization.HostPool", "Azure.Resources.ResourceGroup"],
    },
  });
