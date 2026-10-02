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

export interface AssessmentProjectProps {
  /** Resource group the project is created in. Changing it replaces the project. */
  resourceGroup: string;
  /**
   * Name of the assessment project. If omitted, a unique name is generated
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
   * `Disabled`, only private endpoint connections can reach it and
   * `customerStorageAccountArmId` is required.
   * @default "Enabled"
   */
  publicNetworkAccess?: "Enabled" | "Disabled";
  /**
   * Project status. An `Inactive` project rejects new assessments.
   * @default "Active"
   */
  projectStatus?: "Active" | "Inactive";
  /** ARM ID of the `Migrate.Solution` that tracks this assessment project. */
  assessmentSolutionId?: string;
  /** ARM ID of a Log Analytics workspace used for dependency visualization. */
  customerWorkspaceId?: string;
  /** Location of the Log Analytics workspace in `customerWorkspaceId`. */
  customerWorkspaceLocation?: string;
  /** ARM ID of the storage account used when public access is disabled. */
  customerStorageAccountArmId?: string;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface AssessmentProject extends Resource<
  "Azure.Migrate.AssessmentProject",
  AssessmentProjectProps,
  {
    /** Name of the assessment project. */
    projectName: string;
    /** Resource group that holds the project. */
    resourceGroup: string;
    /** ARM resource ID of the project. */
    projectId: string;
    /** Location of the project. */
    location: string;
    /** Endpoint the collector agent calls for the agent REST API. */
    serviceEndpoint: string;
    /** Project status (`Active` or `Inactive`). */
    projectStatus: string;
    /** Public network access setting. */
    publicNetworkAccess: string;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Migrate assessment project (`Microsoft.Migrate/assessmentProjects`)
 * — the container for assessment groups, assessments, and the appliance
 * collectors that feed discovered machines into them.
 *
 * @see https://learn.microsoft.com/azure/migrate/create-manage-projects
 *
 * ### Creating a Project
 * **Example:** Assessment project
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("migration", {
 *   location: "centralus",
 * });
 * const project = yield* Azure.Migrate.AssessmentProject("assess", {
 *   resourceGroup: group.resourceGroupName,
 *   location: "centralus",
 * });
 * ```
 *
 * ### Pausing a Project
 * **Example:** Mark the project inactive
 * ```typescript
 * const project = yield* Azure.Migrate.AssessmentProject("assess", {
 *   resourceGroup: group.resourceGroupName,
 *   location: "centralus",
 *   projectStatus: "Inactive",
 * });
 * ```
 *
 * @resource
 */
export const AssessmentProject = Resource<AssessmentProject>(
  "Azure.Migrate.AssessmentProject",
);

type ObservedProject = migrate.GetAssessmentProjectsOperationResponse;

export const getAssessmentProject = (
  subscriptionId: string,
  resourceGroupName: string,
  projectName: string,
) =>
  orUndefinedIfNotFound(
    migrate.GetAssessmentProjectsOperation({
      subscriptionId,
      resourceGroupName,
      projectName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  project: ObservedProject,
): AssessmentProject["Attributes"] => ({
  projectName: name,
  resourceGroup,
  projectId: project.id ?? "",
  location: project.location,
  serviceEndpoint: project.properties?.serviceEndpoint ?? "",
  projectStatus: project.properties?.projectStatus ?? "Active",
  publicNetworkAccess: project.properties?.publicNetworkAccess ?? "Enabled",
  tags: userTags(project.tags),
});

const desiredProperties = (news: AssessmentProjectProps) => ({
  publicNetworkAccess: news.publicNetworkAccess,
  projectStatus: news.projectStatus,
  assessmentSolutionId: news.assessmentSolutionId,
  customerWorkspaceId: news.customerWorkspaceId,
  customerWorkspaceLocation: news.customerWorkspaceLocation,
  customerStorageAccountArmId: news.customerStorageAccountArmId,
});

export const AssessmentProjectProvider = () =>
  Provider.succeed(AssessmentProject, {
    stables: ["projectName", "resourceGroup", "projectId", "location"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* migrate
        .ListAssessmentProjectsOperationBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage(
              "ListAssessmentProjectsOperationBySubscription",
              page,
            ),
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
          news.name.toLowerCase() !== output.projectName.toLowerCase()) ||
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
        output?.projectName ?? olds?.name ?? (yield* migrateName(id));
      const observed = yield* getAssessmentProject(
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
      const name = news.name ?? output?.projectName ?? (yield* migrateName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const properties = desiredProperties(news);
      const get = getAssessmentProject(subscriptionId, resourceGroup, name);

      // Observe.
      const observed = yield* get;

      // Ensure + sync: the PUT is a create-or-update of the whole project,
      // so one write covers creation, settings, and tags.
      if (
        observed === undefined ||
        tagsDiffer(observed.tags, tags) ||
        settingsDiffer(properties, observed.properties)
      ) {
        yield* migrate.CreateAssessmentProjectsOperation({
          subscriptionId,
          resourceGroupName: resourceGroup,
          projectName: name,
          location: observed?.location ?? location,
          tags,
          properties,
        });
      }

      const fresh = yield* waitForProvisioned(
        `assessment project ${name}`,
        get,
        (project) => project.properties?.provisioningState,
      );
      return toAttrs(resourceGroup, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        migrate.DeleteAssessmentProjectsOperation({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          projectName: output.projectName,
        }),
      );
      yield* waitUntilGone(
        `assessment project ${output.projectName}`,
        getAssessmentProject(
          subscriptionId,
          output.resourceGroup,
          output.projectName,
        ),
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
