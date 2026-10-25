import * as sphere from "@distilled.cloud/azure/sphere";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import {
  collectAll,
  desiredTags,
  ensureRegistered,
  hasAnyAlchemyTag,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  resourceGroupOf,
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";
import { createCatalogName, sameName } from "./internal.ts";

export interface CatalogProps {
  /**
   * Resource group the catalog is created in.
   *
   * :::caution
   * Changing it replaces the catalog.
   * :::
   */
  resourceGroup: string;
  /**
   * Catalog name: 1-29 letters, digits, `-`, and `_`. If omitted, a unique
   * name is generated from the app, stage, and logical ID.
   *
   * :::caution
   * Changing it replaces the catalog.
   * :::
   * @default a name generated from the app, stage, and logical ID
   */
  name?: string;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   * @default {}
   */
  tags?: Record<string, string>;
}

export interface Catalog extends Resource<
  "Azure.AzureSphere.Catalog",
  CatalogProps,
  {
    /** Name of the catalog. */
    catalogName: string;
    /** ARM resource ID of the catalog. */
    catalogId: string;
    /** Resource group that holds the catalog. */
    resourceGroup: string;
    /** Location of the catalog (always `global`). */
    location: string;
    /** Azure Sphere tenant ID associated with the catalog. */
    tenantId: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Sphere catalog (`Microsoft.AzureSphere/catalogs`) — the
 * Azure Resource Manager home of an Azure Sphere tenant. It holds the
 * products, device groups, devices, images, and certificates of a fleet of
 * Azure Sphere (MT3620) microcontrollers.
 *
 * Catalogs are global resources and free; Azure Sphere bills per claimed
 * device. Microsoft announced the retirement of Azure Sphere: extended
 * support for the OS and security service ends on July 31, 2031, and the
 * product is not recommended for new designs.
 *
 * :::caution
 * Changing `name` or `resourceGroup` replaces the catalog.
 * :::
 *
 * @see https://learn.microsoft.com/azure-sphere/deployment/manage-catalogs
 *
 * ### Creating a Catalog
 * **Example:** Azure Sphere catalog
 * ```typescript
 * const catalog = yield* Azure.AzureSphere.Catalog("fleet");
 * ```
 *
 * **Example:** Named and tagged catalog
 * ```typescript
 * const catalog = yield* Azure.AzureSphere.Catalog("fleet", {
 *   name: "contoso-fleet",
 *   tags: { team: "devices" },
 * });
 * ```
 *
 * @resource
 */
export const Catalog = GroupedResource<Catalog>("Azure.AzureSphere.Catalog");

type ObservedCatalog = sphere.GetCatalogResponse | sphere.Catalog;

/** Azure Sphere catalogs are global. */
const LOCATION = "global";

const getCatalog = (subscriptionId: string, resourceGroupName: string, catalogName: string) =>
  orUndefinedIfNotFound(sphere.GetCatalog({ subscriptionId, resourceGroupName, catalogName }));

const toAttrs = (
  resourceGroup: string,
  name: string,
  observed: ObservedCatalog,
): Catalog["Attributes"] => ({
  catalogName: name,
  catalogId: observed.id ?? "",
  resourceGroup,
  location: observed.location ?? LOCATION,
  tenantId: observed.properties?.tenantId,
  tags: userTags(observed.tags),
});

export const CatalogProvider = () =>
  Provider.succeed(Catalog, {
    stables: ["catalogName", "catalogId", "resourceGroup", "location", "tenantId"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* collectAll(sphere.ListCatalogBySubscription, { subscriptionId });
      return (page.value ?? []).flatMap((catalog) => {
        const group = resourceGroupOf(catalog.id);
        return hasAnyAlchemyTag(catalog.tags) && group !== undefined && catalog.name !== undefined
          ? [toAttrs(group, catalog.name, catalog)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        (news.name !== undefined && !sameName(news.name, output.catalogName))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      if (resourceGroup === undefined) return undefined;
      const name = output?.catalogName ?? olds?.name ?? (yield* createCatalogName(id));
      const observed = yield* getCatalog(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.AzureSphere");
      const resourceGroup = news.resourceGroup;
      const name = news.name ?? output?.catalogName ?? (yield* createCatalogName(id));
      const tags = yield* desiredTags(id, news.tags);
      const get = getCatalog(subscriptionId, resourceGroup, name);
      const waitReady = waitForProvisioned(
        `azure sphere catalog ${name}`,
        get,
        (catalog) => catalog.properties?.provisioningState,
        { interval: "3 seconds", times: 40 },
      );

      // Observe.
      let observed = yield* get;

      // Ensure. Creation is a long-running operation.
      if (observed === undefined) {
        yield* sphere.CatalogsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          catalogName: name,
          location: LOCATION,
          tags,
          properties: {},
        });
      }
      observed = yield* waitReady;

      // Sync tags against observed state (the only mutable aspect).
      if (tagsDiffer(observed.tags, tags)) {
        yield* sphere.UpdateCatalog({
          subscriptionId,
          resourceGroupName: resourceGroup,
          catalogName: name,
          tags,
        });
        observed = yield* waitReady;
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        sphere.DeleteCatalog({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          catalogName: output.catalogName,
        }),
      );
      yield* waitUntilGone(
        `azure sphere catalog ${output.catalogName}`,
        getCatalog(subscriptionId, output.resourceGroup, output.catalogName),
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
