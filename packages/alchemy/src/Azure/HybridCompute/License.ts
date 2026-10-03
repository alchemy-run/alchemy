import * as hybridcompute from "@distilled.cloud/azure/hybridcompute";
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
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";

export type LicenseTarget = hybridcompute.LicenseTarget;
export type LicenseEdition = hybridcompute.LicenseEdition;
export type LicenseCoreType = hybridcompute.LicenseCoreType;
export type LicenseState = hybridcompute.LicenseState;

export interface LicenseProps {
  /**
   * Resource group the license is created in. Changing it replaces the
   * license.
   */
  resourceGroup: string;
  /**
   * Name of the license. If omitted, a unique name is generated from the
   * app, stage, and logical ID. Changing it replaces the license.
   */
  name?: string;
  /**
   * Azure location of the license. Changing it replaces the license.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Windows Server version the Extended Security Updates license covers.
   * Changing it replaces the license.
   */
  target: LicenseTarget;
  /**
   * Windows Server edition. Changing it replaces the license (Azure
   * ignores in-place edition changes).
   */
  edition: LicenseEdition;
  /**
   * Whether the license counts physical (`pCore`) or virtual (`vCore`)
   * cores. Changing it replaces the license.
   */
  coreType: LicenseCoreType;
  /**
   * Number of cores covered. Minimums are 8 for vCore and 16 for pCore;
   * Azure only allows increasing it in place.
   */
  processors: number;
  /**
   * Whether the license is active. **`Activated` starts ESU billing** and
   * the charge cannot be refunded.
   * @default "Deactivated"
   */
  state?: LicenseState;
  /**
   * Microsoft Entra tenant the license belongs to. Changing it replaces
   * the license.
   * @default the tenant of the deploying credentials
   */
  tenantId?: string;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface License extends Resource<
  "Azure.HybridCompute.License",
  LicenseProps,
  {
    /** Name of the license. */
    licenseName: string;
    /** Resource group that holds the license. */
    resourceGroup: string;
    /** ARM resource ID of the license, assigned through a `LicenseProfile`. */
    licenseId: string;
    /** Location of the license. */
    location: string;
    /** Windows Server version the license covers. */
    target: string;
    /** Windows Server edition. */
    edition: string;
    /** Core type (`pCore` or `vCore`). */
    coreType: string;
    /** Number of cores covered. */
    processors: number;
    /** Activation state. */
    state: string;
    /** Number of licenses the processor count translates to. */
    assignedLicenses: number | undefined;
    /** Immutable license identifier. */
    immutableId: string | undefined;
    /** Tenant the license belongs to. */
    tenantId: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A Windows Server Extended Security Updates (ESU) license delivered
 * through Azure Arc. Assign it to Arc-enabled servers with a
 * `LicenseProfile`.
 *
 * A license stays free while `Deactivated`. Setting `state: "Activated"`
 * starts billing for the full ESU term and cannot be refunded.
 *
 * @see https://learn.microsoft.com/azure/azure-arc/servers/prepare-extended-security-updates
 *
 * ### Creating a License
 * **Example:** Deactivated vCore license for Windows Server 2012
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("arc");
 * const license = yield* Azure.HybridCompute.License("esu", {
 *   resourceGroup: group.resourceGroupName,
 *   target: "Windows Server 2012",
 *   edition: "Standard",
 *   coreType: "vCore",
 *   processors: 8,
 * });
 * ```
 *
 * ### Activating a License
 * **Example:** Activate the license (starts billing)
 * ```typescript
 * const license = yield* Azure.HybridCompute.License("esu", {
 *   resourceGroup: group.resourceGroupName,
 *   target: "Windows Server 2012 R2",
 *   edition: "Datacenter",
 *   coreType: "pCore",
 *   processors: 16,
 *   state: "Activated",
 * });
 * ```
 *
 * @resource
 */
export const License = Resource<License>("Azure.HybridCompute.License");

type ObservedLicense = hybridcompute.GetLicenseResponse;

const getLicense = (
  subscriptionId: string,
  resourceGroupName: string,
  licenseName: string,
) =>
  orUndefinedIfNotFound(
    hybridcompute.GetLicense({
      subscriptionId,
      resourceGroupName,
      licenseName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  license: ObservedLicense,
): License["Attributes"] => {
  const details = license.properties?.licenseDetails;
  return {
    licenseName: name,
    resourceGroup,
    licenseId: license.id ?? "",
    location: license.location,
    target: details?.target ?? "",
    edition: details?.edition ?? "",
    coreType: details?.type ?? "",
    processors: details?.processors ?? 0,
    state: details?.state ?? "",
    assignedLicenses: details?.assignedLicenses,
    immutableId: details?.immutableId,
    tenantId: license.properties?.tenantId,
    tags: userTags(license.tags),
  };
};

const nameOf = (id: string) => createPhysicalName({ id, maxLength: 64 });

const differs = (a: string | undefined, b: string | undefined) =>
  (a ?? "").toLowerCase() !== (b ?? "").toLowerCase();

export const LicenseProvider = () =>
  Provider.succeed(License, {
    stables: ["licenseName", "resourceGroup", "licenseId", "location"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* hybridcompute
        .ListLicenseBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListLicenseBySubscription", page),
          ),
        );
      return (page.value ?? []).flatMap((license) => {
        const group = resourceGroupOf(license.id);
        return hasAnyAlchemyTag(license.tags) &&
          group !== undefined &&
          license.name !== undefined
          ? [toAttrs(group, license.name, license)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        differs(news.resourceGroup, output.resourceGroup) ||
        (news.name !== undefined && differs(news.name, output.licenseName)) ||
        (news.location !== undefined &&
          differs(news.location, output.location)) ||
        differs(news.target, output.target) ||
        differs(news.edition, output.edition) ||
        differs(news.coreType, output.coreType) ||
        (news.tenantId !== undefined &&
          output.tenantId !== undefined &&
          differs(news.tenantId, output.tenantId))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      if (resourceGroup === undefined) return undefined;
      const name = output?.licenseName ?? olds?.name ?? (yield* nameOf(id));
      const observed = yield* getLicense(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.HybridCompute");
      const resourceGroup = news.resourceGroup;
      const name = news.name ?? output?.licenseName ?? (yield* nameOf(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const state = news.state ?? "Deactivated";
      const label = `license ${name}`;
      const get = getLicense(subscriptionId, resourceGroup, name);

      // Observe.
      let observed = yield* get;
      const details = observed?.properties?.licenseDetails;

      // Ensure + sync: the PUT is a synchronous upsert of the whole
      // license, so any observed delta is one PUT.
      if (
        observed === undefined ||
        differs(details?.target, news.target) ||
        differs(details?.edition, news.edition) ||
        differs(details?.type, news.coreType) ||
        details?.processors !== news.processors ||
        differs(details?.state, state) ||
        tagsDiffer(observed.tags, tags)
      ) {
        yield* hybridcompute.LicensesCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          licenseName: name,
          location: observed?.location ?? location,
          tags,
          properties: {
            tenantId:
              news.tenantId ?? observed?.properties?.tenantId ?? env.tenantId,
            licenseType: "ESU",
            licenseDetails: {
              state,
              target: news.target,
              edition: news.edition,
              type: news.coreType,
              processors: news.processors,
            },
          },
        });
        observed = yield* waitForProvisioned(
          label,
          get,
          (license) => license.properties?.provisioningState,
        );
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        hybridcompute.DeleteLicense({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          licenseName: output.licenseName,
        }),
      );
      yield* waitUntilGone(
        `license ${output.licenseName}`,
        getLicense(subscriptionId, output.resourceGroup, output.licenseName),
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
