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

export interface ProjectCatalogProps extends CatalogSourceProps {
  /** Resource group of the project. Changing it replaces the catalog. */
  resourceGroup: string;
  /** Name of the project. Changing it replaces the catalog. */
  project: string;
  /**
   * Catalog name: 3-63 letters, digits, hyphens, underscores, and periods.
   * If omitted, a unique name is generated from the app, stage, and
   * logical ID. Changing it replaces the catalog.
   */
  name?: string;
}

export interface ProjectCatalog extends Resource<
  "Azure.DevCenter.ProjectCatalog",
  ProjectCatalogProps,
  CatalogSourceAttributes & {
    /** Name of the project. */
    project: string;
  },
  never,
  Providers
> {}

/**
 * A project catalog — a Git repository folder of environment definitions
 * or image definitions scoped to a single project, so a team can manage
 * its own catalog items without touching the dev center. The catalog
 * syncs right after it is created.
 *
 * Which item types sync is controlled by the project's
 * `catalogItemSyncTypes`, and the dev center must set
 * `projectCatalogItemSyncEnableStatus: "Enabled"`. Private repositories
 * need a personal access token stored in Key Vault (`secretIdentifier`)
 * that the project identity can read.
 *
 * @see https://learn.microsoft.com/azure/deployment-environments/how-to-configure-project-catalog
 *
 * ### Creating a Project Catalog
 * **Example:** Microsoft's public quick-start catalog
 * ```typescript
 * const catalog = yield* Azure.DevCenter.ProjectCatalog("quickstart", {
 *   resourceGroup: group.resourceGroupName,
 *   project: project.projectName,
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
 * const catalog = yield* Azure.DevCenter.ProjectCatalog("team", {
 *   resourceGroup: group.resourceGroupName,
 *   project: project.projectName,
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
export const ProjectCatalog = Resource<ProjectCatalog>(
  "Azure.DevCenter.ProjectCatalog",
);

type Observed = devcenter.GetProjectCatalogResponse;

const getProjectCatalog = (
  subscriptionId: string,
  resourceGroupName: string,
  projectName: string,
  catalogName: string,
) =>
  orUndefinedIfNotFound(
    devcenter.GetProjectCatalog({
      subscriptionId,
      resourceGroupName,
      projectName,
      catalogName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  project: string,
  name: string,
  observed: Observed,
): ProjectCatalog["Attributes"] => ({
  ...toCatalogAttrs(resourceGroup, name, observed),
  project,
});

const stateOf = (observed: Observed) => observed.properties?.provisioningState;

export const ProjectCatalogProvider = () =>
  Provider.succeed(ProjectCatalog, {
    stables: ["catalogName", "catalogId", "project", "resourceGroup"],

    // Catalogs live inside a project; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameArm(news.resourceGroup, output.resourceGroup) ||
        !sameArm(news.project, output.project) ||
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
      const project = output?.project ?? olds?.project;
      if (resourceGroup === undefined || project === undefined) {
        return undefined;
      }
      const name =
        output?.catalogName ?? olds?.name ?? (yield* createDevCenterName(id));
      const observed = yield* getProjectCatalog(
        subscriptionId,
        resourceGroup,
        project,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, project, name, observed);
      return (yield* isOwned(id, observed.properties?.tags))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.DevCenter");
      const { resourceGroup, project } = news;
      const name =
        news.name ?? output?.catalogName ?? (yield* createDevCenterName(id));
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        projectName: project,
        catalogName: name,
      };
      const label = `project catalog ${name}`;
      const get = getProjectCatalog(
        subscriptionId,
        resourceGroup,
        project,
        name,
      );

      // Observe.
      let observed = yield* get;

      // Ensure. The PUT is a long-running operation that also starts a sync.
      if (observed === undefined) {
        yield* devcenter
          .ProjectCatalogsCreateOrUpdate({
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
          .PatchProjectCatalog({ ...where, properties: delta })
          .pipe(Effect.retry(whileCatalogBusy));
        observed = yield* waitForProvisioned(label, get, stateOf, {
          interval: "5 seconds",
          times: 72,
        });
      }

      return toAttrs(resourceGroup, project, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        devcenter
          .DeleteProjectCatalog({
            subscriptionId,
            resourceGroupName: output.resourceGroup,
            projectName: output.project,
            catalogName: output.catalogName,
          })
          .pipe(Effect.retry(whileCatalogBusy)),
      );
      yield* waitUntilGone(
        `project catalog ${output.catalogName}`,
        getProjectCatalog(
          subscriptionId,
          output.resourceGroup,
          output.project,
          output.catalogName,
        ),
        { interval: "5 seconds", times: 72 },
      );
    }),

    nuke: {
      dependsOn: ["Azure.DevCenter.Project", "Azure.Resources.ResourceGroup"],
    },
  });
