import * as datamigration from "@distilled.cloud/azure/datamigration";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import {
  desiredTags,
  ensureRegistered,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  tagsDiffer,
  userTags,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";

/** Source database engine of a migration project. */
export type ProjectSourcePlatform = "SQL" | "MySQL" | "PostgreSql" | "MongoDb";

/** Target Azure database of a migration project. */
export type ProjectTargetPlatform =
  | "SQLDB"
  | "SQLMI"
  | "AzureDbForMySql"
  | "AzureDbForPostgreSql"
  | "MongoDb";

export interface ProjectProps {
  /**
   * Resource group of the classic migration service. Changing it replaces
   * the project.
   */
  resourceGroup: string;
  /**
   * Name of the `Azure.DataMigration.ClassicMigrationService` that holds
   * the project.
   *
   * :::caution
   * Changing the service replaces the project.
   * :::
   */
  service: string;
  /**
   * Name of the project. If omitted, a unique name is generated from the
   * app, stage, and logical ID.
   *
   * :::caution
   * Changing the name replaces the project.
   * :::
   */
  name?: string;
  /**
   * Source database engine, e.g. `PostgreSql`.
   *
   * :::caution
   * Changing the source platform replaces the project.
   * :::
   */
  sourcePlatform: ProjectSourcePlatform;
  /**
   * Target Azure database, e.g. `AzureDbForPostgreSql`.
   *
   * :::caution
   * Changing the target platform replaces the project.
   * :::
   */
  targetPlatform: ProjectTargetPlatform;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface Project extends Resource<
  "Azure.DataMigration.Project",
  ProjectProps,
  {
    /** Name of the project. */
    projectName: string;
    /** Name of the classic migration service that holds the project. */
    serviceName: string;
    /** Resource group of the service. */
    resourceGroup: string;
    /** ARM resource ID of the project. */
    projectId: string;
    /** Location of the project (the service's location). */
    location: string;
    /** Source database engine. */
    sourcePlatform: string;
    /** Target Azure database. */
    targetPlatform: string;
    /** UTC time the project was created. */
    creationTime: string | undefined;
    /** Provisioning state reported by ARM. */
    provisioningState: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A migration project (`Microsoft.DataMigration/services/projects`) in an
 * Azure Database Migration Service (classic) instance. A project fixes the
 * source engine and the target Azure database; migration tasks run inside
 * it. Projects are free.
 *
 * @see https://learn.microsoft.com/azure/dms/tutorial-postgresql-azure-postgresql-online
 *
 * ### Creating a Project
 * **Example:** PostgreSQL to Azure Database for PostgreSQL
 * ```typescript
 * const dms = yield* Azure.DataMigration.ClassicMigrationService("dms", {
 *   virtualSubnetId: subnet.subnetId,
 * });
 * const project = yield* Azure.DataMigration.Project("pg", {
 *   service: dms.serviceName,
 *   sourcePlatform: "PostgreSql",
 *   targetPlatform: "AzureDbForPostgreSql",
 * });
 * ```
 *
 * **Example:** MySQL project with tags
 * ```typescript
 * const project = yield* Azure.DataMigration.Project("mysql", {
 *   service: dms.serviceName,
 *   sourcePlatform: "MySQL",
 *   targetPlatform: "AzureDbForMySql",
 *   tags: { team: "data" },
 * });
 * ```
 *
 * @resource
 */
export const Project = GroupedResource<Project>("Azure.DataMigration.Project");

export class ProjectServiceNotFound extends Data.TaggedError(
  "Azure.DataMigration.ProjectServiceNotFound",
)<{
  readonly serviceName: string;
  readonly message: string;
}> {}

interface Where {
  subscriptionId: string;
  groupName: string;
  serviceName: string;
  projectName: string;
}

type ObservedProject = datamigration.GetProjectResponse;

const physicalName = (id: string) => createPhysicalName({ id, maxLength: 63, lowercase: true });

const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

const getProject = (where: Where) => orUndefinedIfNotFound(datamigration.GetProject(where));

const toAttrs = (where: Where, project: ObservedProject): Project["Attributes"] => ({
  projectName: where.projectName,
  serviceName: where.serviceName,
  resourceGroup: where.groupName,
  projectId: project.id ?? "",
  location: project.location,
  sourcePlatform: project.properties?.sourcePlatform ?? "",
  targetPlatform: project.properties?.targetPlatform ?? "",
  creationTime: project.properties?.creationTime,
  provisioningState: project.properties?.provisioningState,
  tags: userTags(project.tags),
});

export const ProjectProvider = () =>
  Provider.succeed(Project, {
    stables: [
      "projectName",
      "serviceName",
      "resourceGroup",
      "projectId",
      "location",
      "sourcePlatform",
      "targetPlatform",
    ],

    // Projects live inside a classic migration service; nuke removes them
    // with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        !sameName(news.service, output.serviceName) ||
        (news.name !== undefined && !sameName(news.name, output.projectName)) ||
        news.sourcePlatform !== output.sourcePlatform ||
        news.targetPlatform !== output.targetPlatform
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const groupName = output?.resourceGroup ?? olds?.resourceGroup;
      const serviceName = output?.serviceName ?? olds?.service;
      if (groupName === undefined || serviceName === undefined) return undefined;
      const where = {
        subscriptionId,
        groupName,
        serviceName,
        projectName: output?.projectName ?? olds?.name ?? (yield* physicalName(id)),
      };
      const observed = yield* getProject(where);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(where, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.DataMigration");
      const where = {
        subscriptionId,
        groupName: news.resourceGroup,
        serviceName: news.service,
        projectName: news.name ?? output?.projectName ?? (yield* physicalName(id)),
      };
      const tags = yield* desiredTags(id, news.tags);

      // Observe.
      let observed = yield* getProject(where);

      // Ensure + sync. Source and target platforms replace the project (see
      // diff), so tags are the only mutable aspect; the PUT is synchronous
      // and upserts both.
      if (observed === undefined || tagsDiffer(observed.tags, tags)) {
        let location = observed?.location;
        if (location === undefined) {
          // A project lives in its service's location.
          const service = yield* orUndefinedIfNotFound(
            datamigration.GetService({
              subscriptionId,
              groupName: where.groupName,
              serviceName: where.serviceName,
            }),
          );
          if (service === undefined) {
            return yield* new ProjectServiceNotFound({
              serviceName: where.serviceName,
              message: `classic migration service ${where.serviceName} does not exist in ${where.groupName}`,
            });
          }
          location = service.location;
        }
        observed = yield* datamigration.ProjectsCreateOrUpdate({
          ...where,
          location,
          tags,
          properties: {
            sourcePlatform: news.sourcePlatform,
            targetPlatform: news.targetPlatform,
          },
        });
      }

      return toAttrs(where, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const where = {
        subscriptionId,
        groupName: output.resourceGroup,
        serviceName: output.serviceName,
        projectName: output.projectName,
      };
      yield* ignoreNotFound(datamigration.DeleteProject(where));
      yield* waitUntilGone(`migration project ${output.projectName}`, getProject(where));
    }),

    nuke: { dependsOn: ["Azure.DataMigration.ClassicMigrationService"] },
  });
