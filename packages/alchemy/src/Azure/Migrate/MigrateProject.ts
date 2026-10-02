import * as migrate from "@distilled.cloud/azure/migrate";
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
import { migrateName, settingsDiffer } from "./Common.ts";

export interface MigrateProjectProps {
  /** Resource group the project is created in. Changing it replaces the project. */
  resourceGroup: string;
  /**
   * Name of the Migrate project. If omitted, a unique name is generated
   * from the app, stage, and logical ID. Changing it replaces the project.
   */
  name?: string;
  /**
   * Azure location of the project. Azure Migrate serves a fixed set of
   * geographies (e.g. `centralus`, `westus2`, `westeurope`; not `eastus`).
   * Changing it replaces the project.
   * @default the `Azure.Location` layer, else the profile location
   */
  location?: string;
  /**
   * Whether the project accepts traffic over the public endpoint. With
   * `Disabled`, only private endpoint connections can reach it.
   * @default "Enabled"
   */
  publicNetworkAccess?: "Enabled" | "Disabled";
  /** ARM ID of the storage account Azure Migrate uses for replication data. */
  utilityStorageAccountId?: string;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface MigrateProject extends Resource<
  "Azure.Migrate.MigrateProject",
  MigrateProjectProps,
  {
    /** Name of the Migrate project. */
    migrateProjectName: string;
    /** Resource group that holds the project. */
    resourceGroup: string;
    /** ARM resource ID of the project; use it as a solution's parent. */
    migrateProjectId: string;
    /** Location of the project. */
    location: string;
    /** Hub endpoint registered tools call. */
    serviceEndpoint: string;
    /** Public network access setting. */
    publicNetworkAccess: string;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Migrate project (`Microsoft.Migrate/migrateProjects`) — the hub
 * that discovery, assessment, and migration tools register with as
 * `Migrate.Solution`s and report their summaries to.
 *
 * @see https://learn.microsoft.com/azure/migrate/create-manage-projects
 *
 * ### Creating a Project
 * **Example:** Migrate project
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("migration", {
 *   location: "centralus",
 * });
 * const hub = yield* Azure.Migrate.MigrateProject("hub", {
 *   resourceGroup: group.resourceGroupName,
 *   location: "centralus",
 * });
 * ```
 *
 * ### Private Access
 * **Example:** Disable the public endpoint
 * ```typescript
 * const hub = yield* Azure.Migrate.MigrateProject("hub", {
 *   resourceGroup: group.resourceGroupName,
 *   location: "centralus",
 *   publicNetworkAccess: "Disabled",
 * });
 * ```
 *
 * @resource
 */
export const MigrateProject = Resource<MigrateProject>(
  "Azure.Migrate.MigrateProject",
);

type ObservedProject = migrate.MigrateProject;

export const getMigrateProject = (
  subscriptionId: string,
  resourceGroupName: string,
  migrateProjectName: string,
) =>
  orUndefinedIfNotFound(
    migrate.MigrateProjectsControllerGetMigrateProject({
      subscriptionId,
      resourceGroupName,
      migrateProjectName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  project: ObservedProject,
  location = "",
): MigrateProject["Attributes"] => ({
  migrateProjectName: name,
  resourceGroup,
  migrateProjectId: project.id ?? "",
  location: project.location ?? location,
  serviceEndpoint: project.properties?.serviceEndpoint ?? "",
  publicNetworkAccess: project.properties?.publicNetworkAccess ?? "Enabled",
  tags: userTags(project.tags),
});

const desiredProperties = (news: MigrateProjectProps) => ({
  publicNetworkAccess: news.publicNetworkAccess,
  utilityStorageAccountId: news.utilityStorageAccountId,
});

export const MigrateProjectProvider = () =>
  Provider.succeed(MigrateProject, {
    stables: [
      "migrateProjectName",
      "resourceGroup",
      "migrateProjectId",
      "location",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* migrate
        .ListProjectBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListProjectBySubscription", page),
          ),
        );
      return (page.value ?? []).flatMap((project) => {
        const group = resourceGroupOf(project.id);
        return hasAnyAlchemyTag(project.tags) &&
          group !== undefined &&
          project.name !== undefined
          ? [toAttrs(group, project.name, project)]
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
            output.migrateProjectName.toLowerCase()) ||
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
        output?.migrateProjectName ?? olds?.name ?? (yield* migrateName(id));
      const observed = yield* getMigrateProject(
        subscriptionId,
        resourceGroup,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.Migrate");
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ?? output?.migrateProjectName ?? (yield* migrateName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const properties = desiredProperties(news);
      const get = getMigrateProject(subscriptionId, resourceGroup, name);

      // Observe.
      const observed = yield* get;

      // Ensure + sync: the PUT is a create-or-update of the whole project,
      // so one write covers creation, settings, and tags.
      if (
        observed === undefined ||
        tagsDiffer(observed.tags, tags) ||
        settingsDiffer(properties, observed.properties)
      ) {
        yield* migrate.MigrateProjectsControllerPutMigrateProject({
          subscriptionId,
          resourceGroupName: resourceGroup,
          migrateProjectName: name,
          location: observed?.location ?? location,
          tags,
          properties,
        });
      }

      const fresh = yield* waitForProvisioned(
        `migrate project ${name}`,
        get,
        () => undefined,
      );
      return toAttrs(resourceGroup, name, fresh, location);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        migrate.MigrateProjectsControllerDeleteMigrateProject({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          migrateProjectName: output.migrateProjectName,
        }),
      );
      yield* waitUntilGone(
        `migrate project ${output.migrateProjectName}`,
        getMigrateProject(
          subscriptionId,
          output.resourceGroup,
          output.migrateProjectName,
        ),
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
