import * as devcenter from "@distilled.cloud/azure/devcenter";
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
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  catalogDelta,
  sourceTypeOf,
  toCatalogAttrs,
  toGitCatalog,
  whileCatalogBusy,
  type CatalogSourceAttributes,
  type CatalogSourceProps,
} from "./CatalogCommon.ts";
import { createDevCenterName, sameArm } from "./Common.ts";

export type { CatalogGitSource, CatalogSyncType } from "./CatalogCommon.ts";

export interface CatalogProps extends CatalogSourceProps {
  /** Resource group of the dev center. Changing it replaces the catalog. */
  resourceGroup: string;
  /** Name of the dev center. Changing it replaces the catalog. */
  devCenter: string;
  /**
   * Catalog name: 3-63 letters, digits, hyphens, underscores, and periods.
   * If omitted, a unique name is generated from the app, stage, and
   * logical ID. Changing it replaces the catalog.
   */
  name?: string;
}

export interface Catalog extends Resource<
  "Azure.DevCenter.Catalog",
  CatalogProps,
  CatalogSourceAttributes & {
    /** Name of the dev center. */
    devCenter: string;
  },
  never,
  Providers
> {}

/**
 * A dev center catalog — a Git repository folder of environment
 * definitions (Azure Deployment Environments) or image definitions and
 * customization tasks (Dev Box) shared with every project of the dev
 * center. The catalog syncs right after it is created.
 *
 * Private repositories need a personal access token stored in Key Vault
 * (`secretIdentifier`) that the dev center identity can read.
 *
 * @see https://learn.microsoft.com/azure/deployment-environments/how-to-configure-catalog
 *
 * ### Creating a Catalog
 * **Example:** Microsoft's public quick-start catalog
 * ```typescript
 * const catalog = yield* Azure.DevCenter.Catalog("quickstart", {
 *   resourceGroup: group.resourceGroupName,
 *   devCenter: center.devCenterName,
 *   gitHub: {
 *     uri: "https://github.com/microsoft/devcenter-catalog.git",
 *     branch: "main",
 *     path: "/Environment-Definitions",
 *   },
 * });
 * ```
 *
 * **Example:** Private repository with a Key Vault PAT
 * ```typescript
 * const catalog = yield* Azure.DevCenter.Catalog("team", {
 *   resourceGroup: group.resourceGroupName,
 *   devCenter: center.devCenterName,
 *   gitHub: {
 *     uri: "https://github.com/acme/environments.git",
 *     branch: "main",
 *     path: "/definitions",
 *     secretIdentifier: "https://acme-kv.vault.azure.net/secrets/github-pat",
 *   },
 *   syncType: "Scheduled",
 * });
 * ```
 *
 * @resource
 */
export const Catalog = Resource<Catalog>("Azure.DevCenter.Catalog");

type Observed = devcenter.GetCatalogResponse;

const getCatalog = (
  subscriptionId: string,
  resourceGroupName: string,
  devCenterName: string,
  catalogName: string,
) =>
  orUndefinedIfNotFound(
    devcenter.GetCatalog({
      subscriptionId,
      resourceGroupName,
      devCenterName,
      catalogName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  devCenter: string,
  name: string,
  observed: Observed,
): Catalog["Attributes"] => ({
  ...toCatalogAttrs(resourceGroup, name, observed),
  devCenter,
});

const stateOf = (observed: Observed) => observed.properties?.provisioningState;

export const CatalogProvider = () =>
  Provider.succeed(Catalog, {
    stables: ["catalogName", "catalogId", "devCenter", "resourceGroup"],

    // Catalogs live inside a dev center; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameArm(news.resourceGroup, output.resourceGroup) ||
        !sameArm(news.devCenter, output.devCenter) ||
        (news.name !== undefined && !sameArm(news.name, output.catalogName)) ||
        sourceTypeOf(news) !== output.sourceType
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const devCenter = output?.devCenter ?? olds?.devCenter;
      if (resourceGroup === undefined || devCenter === undefined) {
        return undefined;
      }
      const name =
        output?.catalogName ?? olds?.name ?? (yield* createDevCenterName(id));
      const observed = yield* getCatalog(
        subscriptionId,
        resourceGroup,
        devCenter,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, devCenter, name, observed);
      return (yield* isOwned(id, observed.properties?.tags))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.DevCenter");
      const { resourceGroup, devCenter } = news;
      const name =
        news.name ?? output?.catalogName ?? (yield* createDevCenterName(id));
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        devCenterName: devCenter,
        catalogName: name,
      };
      const label = `dev center catalog ${name}`;
      const get = getCatalog(subscriptionId, resourceGroup, devCenter, name);

      // Observe.
      let observed = yield* get;

      // Ensure. The PUT is a long-running operation that also starts a sync.
      if (observed === undefined) {
        yield* devcenter
          .CatalogsCreateOrUpdate({
            ...where,
            properties: {
              gitHub: toGitCatalog(news.gitHub),
              adoGit: toGitCatalog(news.adoGit),
              syncType: news.syncType,
              tags,
            },
          })
          .pipe(Effect.retry(whileCatalogBusy));
      }
      observed = yield* waitForProvisioned(label, get, stateOf, {
        interval: "5 seconds",
        times: 72,
      });

      // Sync source, sync type, and tags against observed state.
      const delta = catalogDelta(
        observed,
        news,
        tags,
        tagsDiffer(observed.properties?.tags, tags),
      );
      if (delta !== undefined) {
        yield* devcenter
          .UpdateCatalog({ ...where, properties: delta })
          .pipe(Effect.retry(whileCatalogBusy));
        observed = yield* waitForProvisioned(label, get, stateOf, {
          interval: "5 seconds",
          times: 72,
        });
      }

      return toAttrs(resourceGroup, devCenter, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        devcenter
          .DeleteCatalog({
            subscriptionId,
            resourceGroupName: output.resourceGroup,
            devCenterName: output.devCenter,
            catalogName: output.catalogName,
          })
          .pipe(Effect.retry(whileCatalogBusy)),
      );
      yield* waitUntilGone(
        `dev center catalog ${output.catalogName}`,
        getCatalog(
          subscriptionId,
          output.resourceGroup,
          output.devCenter,
          output.catalogName,
        ),
        { interval: "5 seconds", times: 72 },
      );
    }),

    nuke: {
      dependsOn: ["Azure.DevCenter.DevCenter", "Azure.Resources.ResourceGroup"],
    },
  });
