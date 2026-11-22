import * as sphere from "@distilled.cloud/azure/sphere";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";
import {
  createAlphanumericName,
  descriptionWithMarker,
  hasMarker,
  ownershipMarker,
  sameName,
  stripMarker,
} from "./internal.ts";

export type OSFeedType = sphere.OSFeedType;
export type UpdatePolicy = sphere.UpdatePolicy;
export type RegionalDataBoundary = sphere.RegionalDataBoundary;

export interface DeviceGroupProps {
  /**
   * Resource group of the catalog.
   *
   * :::caution
   * Changing it replaces the device group.
   * :::
   */
  resourceGroup: string;
  /**
   * Catalog that holds the product.
   *
   * :::caution
   * Changing it replaces the device group.
   * :::
   */
  catalog: string;
  /**
   * Product the device group belongs to.
   *
   * :::caution
   * Changing it replaces the device group.
   * :::
   */
  product: string;
  /**
   * Device group name: 3-50 letters, digits, and spaces. If omitted, a
   * unique alphanumeric name is generated from the app, stage, and logical ID.
   *
   * :::caution
   * Changing it replaces the device group.
   * :::
   * @default an alphanumeric name generated from the app, stage, and logical ID
   */
  name?: string;
  /**
   * Description of the device group, at most 77 characters: Azure Sphere stores
   * at most 100, and Alchemy appends a 23-character ownership marker.
   * @default no description
   */
  description?: string;
  /**
   * Operating system feed of the devices: `Retail` (production OS) or
   * `RetailEval` (the next OS release, two weeks early).
   * @default "Retail"
   */
  osFeedType?: OSFeedType;
  /**
   * Which updates the devices receive: `UpdateAll` or
   * `No3rdPartyAppUpdates` (OS updates only).
   * @default "UpdateAll"
   */
  updatePolicy?: UpdatePolicy;
  /**
   * Whether devices upload crash dumps to Microsoft.
   * @default false
   */
  allowCrashDumpsCollection?: boolean;
  /**
   * Regional data boundary for crash dumps: `None` or `EU`.
   * @default "None"
   */
  regionalDataBoundary?: RegionalDataBoundary;
}

export interface DeviceGroup extends Resource<
  "Azure.AzureSphere.DeviceGroup",
  DeviceGroupProps,
  {
    /** Name of the device group. */
    deviceGroupName: string;
    /** ARM resource ID of the device group. */
    deviceGroupId: string;
    /** Product the device group belongs to. */
    productName: string;
    /** Catalog that holds the product. */
    catalogName: string;
    /** Resource group of the catalog. */
    resourceGroup: string;
    /** Description (Alchemy ownership marker stripped). */
    description: string | undefined;
    /** Operating system feed of the devices. */
    osFeedType: string | undefined;
    /** Which updates the devices receive. */
    updatePolicy: string | undefined;
    /** Whether devices upload crash dumps. */
    allowCrashDumpsCollection: boolean;
    /** Regional data boundary for crash dumps. */
    regionalDataBoundary: string | undefined;
    /** Whether the device group has a deployment. */
    hasDeployment: boolean;
  },
  never,
  Providers
> {}

/**
 * An Azure Sphere device group
 * (`Microsoft.AzureSphere/catalogs/products/deviceGroups`) — a set of
 * devices of one product that share an OS feed, an update policy, and an
 * application deployment (e.g. `Field Test` or `Production`).
 *
 * Device groups have no tags, so Alchemy records ownership as a
 * `[alchemy <hash>]` marker (a hash of the stack, stage, and logical ID)
 * at the end of `description`.
 *
 * :::caution
 * Changing `catalog`, `product`, `name`, or `resourceGroup` replaces the
 * device group.
 * :::
 *
 * @see https://learn.microsoft.com/azure-sphere/deployment/deployment-concepts
 *
 * ### Creating a Device Group
 * **Example:** Field test device group
 * ```typescript
 * const catalog = yield* Azure.AzureSphere.Catalog("fleet");
 * const product = yield* Azure.AzureSphere.Product("dishwasher", {
 *   catalog: catalog.catalogName,
 * });
 * const group = yield* Azure.AzureSphere.DeviceGroup("field-test", {
 *   catalog: catalog.catalogName,
 *   product: product.productName,
 *   description: "Dishwashers in the field trial",
 * });
 * ```
 *
 * ### Configuring Updates
 * **Example:** Early OS feed, OS updates only, EU crash dumps
 * ```typescript
 * const catalog = yield* Azure.AzureSphere.Catalog("fleet");
 * const product = yield* Azure.AzureSphere.Product("dishwasher", {
 *   catalog: catalog.catalogName,
 * });
 * const group = yield* Azure.AzureSphere.DeviceGroup("os-eval", {
 *   catalog: catalog.catalogName,
 *   product: product.productName,
 *   osFeedType: "RetailEval",
 *   updatePolicy: "No3rdPartyAppUpdates",
 *   allowCrashDumpsCollection: true,
 *   regionalDataBoundary: "EU",
 * });
 * ```
 *
 * @resource
 */
export const DeviceGroup = GroupedResource<DeviceGroup>("Azure.AzureSphere.DeviceGroup");

interface Where {
  subscriptionId: string;
  resourceGroupName: string;
  catalogName: string;
  productName: string;
  deviceGroupName: string;
}

const getDeviceGroup = (where: Where) => orUndefinedIfNotFound(sphere.GetDeviceGroup(where));

const toAttrs = (
  where: Where,
  observed: sphere.GetDeviceGroupResponse,
): DeviceGroup["Attributes"] => ({
  deviceGroupName: where.deviceGroupName,
  deviceGroupId: observed.id ?? "",
  productName: where.productName,
  catalogName: where.catalogName,
  resourceGroup: where.resourceGroupName,
  description: stripMarker(observed.properties?.description),
  osFeedType: observed.properties?.osFeedType,
  updatePolicy: observed.properties?.updatePolicy,
  allowCrashDumpsCollection: observed.properties?.allowCrashDumpsCollection === "Enabled",
  regionalDataBoundary: observed.properties?.regionalDataBoundary,
  hasDeployment: observed.properties?.hasDeployment ?? false,
});

const lower = (value: string | undefined) => value?.toLowerCase();

export const DeviceGroupProvider = () =>
  Provider.succeed(DeviceGroup, {
    stables: ["deviceGroupName", "deviceGroupId", "productName", "catalogName", "resourceGroup"],

    // Device groups live inside a product; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        !sameName(news.catalog, output.catalogName) ||
        !sameName(news.product, output.productName) ||
        (news.name !== undefined && !sameName(news.name, output.deviceGroupName))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroupName = output?.resourceGroup ?? olds?.resourceGroup;
      const catalogName = output?.catalogName ?? olds?.catalog;
      const productName = output?.productName ?? olds?.product;
      if (
        resourceGroupName === undefined ||
        catalogName === undefined ||
        productName === undefined
      ) {
        return undefined;
      }
      const where = {
        subscriptionId,
        resourceGroupName,
        catalogName,
        productName,
        deviceGroupName:
          output?.deviceGroupName ?? olds?.name ?? (yield* createAlphanumericName(id)),
      };
      const observed = yield* getDeviceGroup(where);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(where, observed);
      return (yield* hasMarker(id, observed.properties?.description)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.AzureSphere");
      const where = {
        subscriptionId,
        resourceGroupName: news.resourceGroup,
        catalogName: news.catalog,
        productName: news.product,
        deviceGroupName:
          news.name ?? output?.deviceGroupName ?? (yield* createAlphanumericName(id)),
      };
      const marker = yield* ownershipMarker(id);
      const properties = {
        description: descriptionWithMarker(news.description, marker),
        osFeedType: news.osFeedType ?? "Retail",
        updatePolicy: news.updatePolicy ?? "UpdateAll",
        allowCrashDumpsCollection: news.allowCrashDumpsCollection ? "Enabled" : "Disabled",
        regionalDataBoundary: news.regionalDataBoundary ?? "None",
      } satisfies sphere.DeviceGroupPropertiesInput;
      const waitReady = waitForProvisioned(
        `azure sphere device group ${where.deviceGroupName}`,
        getDeviceGroup(where),
        (group) => group.properties?.provisioningState,
      );

      // Observe.
      let observed = yield* getDeviceGroup(where);

      // Ensure.
      if (observed === undefined) {
        yield* sphere.DeviceGroupsCreateOrUpdate({ ...where, properties });
      }
      observed = yield* waitReady;

      // Sync settings against observed state. The create PUT ignores
      // `allowCrashDumpsCollection`; only the PATCH applies it.
      const current = observed.properties ?? {};
      if (
        current.description !== properties.description ||
        lower(current.osFeedType) !== lower(properties.osFeedType) ||
        lower(current.updatePolicy) !== lower(properties.updatePolicy) ||
        lower(current.allowCrashDumpsCollection) !== lower(properties.allowCrashDumpsCollection) ||
        lower(current.regionalDataBoundary) !== lower(properties.regionalDataBoundary)
      ) {
        yield* sphere.UpdateDeviceGroup({ ...where, properties });
        observed = yield* waitReady;
      }

      return toAttrs(where, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const where = {
        subscriptionId,
        resourceGroupName: output.resourceGroup,
        catalogName: output.catalogName,
        productName: output.productName,
        deviceGroupName: output.deviceGroupName,
      };
      yield* ignoreNotFound(sphere.DeleteDeviceGroup(where));
      yield* waitUntilGone(
        `azure sphere device group ${output.deviceGroupName}`,
        getDeviceGroup(where),
      );
    }),

    nuke: { dependsOn: ["Azure.AzureSphere.Product"] },
  });
