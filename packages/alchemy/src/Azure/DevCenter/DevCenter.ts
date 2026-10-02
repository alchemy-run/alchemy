import * as devcenter from "@distilled.cloud/azure/devcenter";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
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
  containsValue,
  createDevCenterName,
  getDevCenter,
  identityDiffers,
  sameArm,
  toIdentityInput,
  type DevCenterIdentity,
} from "./Common.ts";

export type DevCenterEncryption = devcenter.Encryption;
export type DevCenterEnableStatus = "Enabled" | "Disabled";

export interface DevCenterProps {
  /** Resource group the dev center is created in. Changing it replaces the dev center. */
  resourceGroup: string;
  /**
   * Dev center name: 3-26 letters, digits, and hyphens. It is part of the
   * dev center's data-plane endpoint. If omitted, a unique name is
   * generated from the app, stage, and logical ID. Changing it replaces the
   * dev center.
   */
  name?: string;
  /**
   * Azure location of the dev center. Changing it replaces the dev center.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Managed identity of the dev center. The identity reads catalog secrets
   * from Key Vault, attaches compute galleries, and deploys environments.
   */
  identity?: DevCenterIdentity;
  /** Display name of the dev center. */
  displayName?: string;
  /** Customer-managed key encryption for proprietary content. */
  encryption?: DevCenterEncryption;
  /**
   * Whether projects of the dev center may attach their own catalogs.
   * @default Azure's default (`Disabled`)
   */
  projectCatalogItemSyncEnableStatus?: DevCenterEnableStatus;
  /**
   * Whether pools may use Microsoft-hosted networking instead of an
   * attached network connection.
   * @default Azure's default (`Enabled`)
   */
  microsoftHostedNetworkEnableStatus?: DevCenterEnableStatus;
  /**
   * Whether the Azure Monitor agent is installed on new dev boxes.
   * @default Azure's default (`Disabled`)
   */
  installAzureMonitorAgentEnableStatus?: DevCenterEnableStatus;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface DevCenter extends Resource<
  "Azure.DevCenter.DevCenter",
  DevCenterProps,
  {
    /** Name of the dev center. */
    devCenterName: string;
    /** ARM resource ID of the dev center; pass it to `Project.devCenterId`. */
    devCenterId: string;
    /** Resource group that holds the dev center. */
    resourceGroup: string;
    /** Location of the dev center. */
    location: string;
    /** Data-plane endpoint, e.g. `https://{tenant}-{name}.{region}.devcenter.azure.com/`. */
    devCenterUri: string | undefined;
    /** Identity type of the dev center (`None` when it has no identity). */
    identityType: string | undefined;
    /** Object ID of the dev center's system-assigned identity. */
    principalId: string | undefined;
    /** Microsoft Entra tenant of the system-assigned identity. */
    tenantId: string | undefined;
    /** Display name of the dev center. */
    displayName: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A Microsoft Dev Center — the top-level control plane for Microsoft Dev
 * Box and Azure Deployment Environments. Platform engineers attach
 * networks, galleries, catalogs, dev box definitions, and environment
 * types to a dev center, and group developers into projects. The dev
 * center itself is free; billing starts when developers create dev boxes
 * or environments.
 *
 * @see https://learn.microsoft.com/azure/dev-box/concept-dev-box-concepts
 *
 * ### Creating a Dev Center
 * **Example:** Dev center with a system-assigned identity
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("platform");
 * const center = yield* Azure.DevCenter.DevCenter("center", {
 *   resourceGroup: group.resourceGroupName,
 *   identity: { type: "SystemAssigned" },
 *   displayName: "Platform Dev Center",
 * });
 * ```
 *
 * ### Settings
 * **Example:** Let projects bring their own catalogs
 * ```typescript
 * const center = yield* Azure.DevCenter.DevCenter("center", {
 *   resourceGroup: group.resourceGroupName,
 *   projectCatalogItemSyncEnableStatus: "Enabled",
 *   installAzureMonitorAgentEnableStatus: "Enabled",
 * });
 * ```
 *
 * @resource
 */
export const DevCenter = Resource<DevCenter>("Azure.DevCenter.DevCenter");

type ObservedDevCenter = devcenter.GetDevCenterResponse;

const toAttrs = (
  resourceGroup: string,
  name: string,
  center: ObservedDevCenter,
): DevCenter["Attributes"] => ({
  devCenterName: name,
  devCenterId: center.id ?? "",
  resourceGroup,
  location: center.location,
  devCenterUri: center.properties?.devCenterUri,
  identityType: center.identity?.type,
  principalId: center.identity?.principalId,
  tenantId: center.identity?.tenantId,
  displayName: center.properties?.displayName,
  tags: userTags(center.tags),
});

const desiredProperties = (
  news: DevCenterProps,
): devcenter.DevCenterPropertiesInput => ({
  displayName: news.displayName,
  encryption: news.encryption,
  projectCatalogSettings:
    news.projectCatalogItemSyncEnableStatus === undefined
      ? undefined
      : {
          catalogItemSyncEnableStatus: news.projectCatalogItemSyncEnableStatus,
        },
  networkSettings:
    news.microsoftHostedNetworkEnableStatus === undefined
      ? undefined
      : {
          microsoftHostedNetworkEnableStatus:
            news.microsoftHostedNetworkEnableStatus,
        },
  devBoxProvisioningSettings:
    news.installAzureMonitorAgentEnableStatus === undefined
      ? undefined
      : {
          installAzureMonitorAgentEnableStatus:
            news.installAzureMonitorAgentEnableStatus,
        },
});

/** A dev center rejects deletion while projects still reference it. */
const whileInUse = {
  while: (e: { readonly _tag: string }) => e._tag === "ResourceConflict",
  schedule: Schedule.spaced("10 seconds"),
  times: 12,
} as const;

export const DevCenterProvider = () =>
  Provider.succeed(DevCenter, {
    stables: ["devCenterName", "devCenterId", "resourceGroup", "location"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* devcenter
        .ListDevCenterBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListDevCenterBySubscription", page),
          ),
        );
      return (page.value ?? []).flatMap((center) => {
        const group = resourceGroupOf(center.id);
        return hasAnyAlchemyTag(center.tags) &&
          group !== undefined &&
          center.name !== undefined
          ? [toAttrs(group, center.name, center)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameArm(news.resourceGroup, output.resourceGroup) ||
        (news.name !== undefined && !sameArm(news.name, output.devCenterName)) ||
        (news.location !== undefined &&
          !sameArm(news.location, output.location))
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
        output?.devCenterName ??
        olds?.name ??
        (yield* createDevCenterName(id, 26));
      const observed = yield* getDevCenter(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.DevCenter");
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ?? output?.devCenterName ?? (yield* createDevCenterName(id, 26));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const properties = desiredProperties(news);
      const identity = toIdentityInput(news.identity);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        devCenterName: name,
      };
      const label = `dev center ${name}`;
      const get = getDevCenter(subscriptionId, resourceGroup, name);
      const stateOf = (center: ObservedDevCenter) =>
        center.properties?.provisioningState;

      // Observe.
      let observed = yield* get;

      // Ensure. The PUT is a long-running operation.
      if (observed === undefined) {
        yield* devcenter.DevCentersCreateOrUpdate({
          ...where,
          location,
          tags,
          identity,
          properties,
        });
      }
      observed = yield* waitForProvisioned(label, get, stateOf, {
        interval: "5 seconds",
        times: 60,
      });

      // Sync properties, identity, and tags against the observed state.
      const propsChanged = !containsValue(observed.properties, properties);
      const identityChanged = identityDiffers(observed.identity, news.identity);
      const tagsChanged = tagsDiffer(observed.tags, tags);
      if (propsChanged || identityChanged || tagsChanged) {
        yield* devcenter.UpdateDevCenter({
          ...where,
          tags: tagsChanged ? tags : undefined,
          identity: identityChanged ? identity : undefined,
          properties: propsChanged ? properties : undefined,
        });
        observed = yield* waitForProvisioned(label, get, stateOf, {
          interval: "5 seconds",
          times: 60,
        });
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        devcenter
          .DeleteDevCenter({
            subscriptionId,
            resourceGroupName: output.resourceGroup,
            devCenterName: output.devCenterName,
          })
          .pipe(Effect.retry(whileInUse)),
      );
      yield* waitUntilGone(
        `dev center ${output.devCenterName}`,
        getDevCenter(subscriptionId, output.resourceGroup, output.devCenterName),
        { interval: "5 seconds", times: 72 },
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
