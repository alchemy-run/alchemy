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
  getProject,
  identityDiffers,
  sameArm,
  toIdentityInput,
  type DevCenterIdentity,
} from "./Common.ts";

export type ProjectCatalogItemSyncType =
  | "EnvironmentDefinition"
  | "ImageDefinition";

export interface ProjectProps {
  /** Resource group the project is created in. Changing it replaces the project. */
  resourceGroup: string;
  /**
   * ARM resource ID of the dev center the project belongs to. A project
   * cannot move between dev centers; changing it replaces the project.
   */
  devCenterId: string;
  /**
   * Project name: 3-63 letters, digits, hyphens, underscores, and periods.
   * If omitted, a unique name is generated from the app, stage, and
   * logical ID. Changing it replaces the project.
   */
  name?: string;
  /**
   * Azure location of the project. Changing it replaces the project.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /** Description of the project. */
  description?: string;
  /** Display name of the project. */
  displayName?: string;
  /**
   * Maximum number of dev boxes a single user may create across all pools
   * of the project. `0` means no limit. Lowering it does not affect
   * existing dev boxes.
   */
  maxDevBoxesPerUser?: number;
  /**
   * Catalog item types synced from project catalogs. Requires the dev
   * center's `projectCatalogItemSyncEnableStatus: "Enabled"`.
   */
  catalogItemSyncTypes?: ProjectCatalogItemSyncType[];
  /** Managed identity of the project. */
  identity?: DevCenterIdentity;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface Project extends Resource<
  "Azure.DevCenter.Project",
  ProjectProps,
  {
    /** Name of the project. */
    projectName: string;
    /** ARM resource ID of the project. */
    projectId: string;
    /** Resource group that holds the project. */
    resourceGroup: string;
    /** Location of the project. */
    location: string;
    /** ARM resource ID of the dev center the project belongs to. */
    devCenterId: string;
    /** Data-plane endpoint of the project's dev center. */
    devCenterUri: string | undefined;
    /** Description of the project. */
    description: string | undefined;
    /** Maximum dev boxes per user (`0` or unset means no limit). */
    maxDevBoxesPerUser: number | undefined;
    /** Object ID of the project's system-assigned identity. */
    principalId: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A Dev Center project — the unit of access for developers. Projects
 * group dev box pools, environment types, and catalogs for a team, and
 * are where developers are granted the Dev Box User and Deployment
 * Environments User roles.
 *
 * @see https://learn.microsoft.com/azure/dev-box/how-to-manage-dev-box-projects
 *
 * ### Creating a Project
 * **Example:** Project in a dev center
 * ```typescript
 * const center = yield* Azure.DevCenter.DevCenter("center", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * const project = yield* Azure.DevCenter.Project("team", {
 *   resourceGroup: group.resourceGroupName,
 *   devCenterId: center.devCenterId,
 *   description: "Team A",
 * });
 * ```
 *
 * ### Limits
 * **Example:** Cap dev boxes per developer
 * ```typescript
 * const project = yield* Azure.DevCenter.Project("team", {
 *   resourceGroup: group.resourceGroupName,
 *   devCenterId: center.devCenterId,
 *   maxDevBoxesPerUser: 2,
 * });
 * ```
 *
 * @resource
 */
export const Project = Resource<Project>("Azure.DevCenter.Project");

type ObservedProject = devcenter.GetProjectResponse;

const toAttrs = (
  resourceGroup: string,
  name: string,
  project: ObservedProject,
): Project["Attributes"] => ({
  projectName: name,
  projectId: project.id ?? "",
  resourceGroup,
  location: project.location,
  devCenterId: project.properties?.devCenterId ?? "",
  devCenterUri: project.properties?.devCenterUri,
  description: project.properties?.description,
  maxDevBoxesPerUser: project.properties?.maxDevBoxesPerUser,
  principalId: project.identity?.principalId,
  tags: userTags(project.tags),
});

/** A freshly created dev center can lag before projects may reference it. */
const whileDevCenterPending = {
  while: (e: { readonly _tag: string }) => e._tag === "ResourceConflict",
  schedule: Schedule.spaced("10 seconds"),
  times: 12,
} as const;

export const ProjectProvider = () =>
  Provider.succeed(Project, {
    stables: [
      "projectName",
      "projectId",
      "resourceGroup",
      "location",
      "devCenterId",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* devcenter
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
        !sameArm(news.resourceGroup, output.resourceGroup) ||
        !sameArm(news.devCenterId, output.devCenterId) ||
        (news.name !== undefined && !sameArm(news.name, output.projectName)) ||
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
        output?.projectName ?? olds?.name ?? (yield* createDevCenterName(id));
      const observed = yield* getProject(subscriptionId, resourceGroup, name);
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
        news.name ?? output?.projectName ?? (yield* createDevCenterName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const mutable: devcenter.ProjectPropertiesInput = {
        description: news.description,
        displayName: news.displayName,
        maxDevBoxesPerUser: news.maxDevBoxesPerUser,
        catalogSettings:
          news.catalogItemSyncTypes === undefined
            ? undefined
            : { catalogItemSyncTypes: news.catalogItemSyncTypes },
      };
      const identity = toIdentityInput(news.identity);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        projectName: name,
      };
      const label = `dev center project ${name}`;
      const get = getProject(subscriptionId, resourceGroup, name);
      const stateOf = (project: ObservedProject) =>
        project.properties?.provisioningState;

      // Observe.
      let observed = yield* get;

      // Ensure. The PUT is a long-running operation.
      if (observed === undefined) {
        yield* devcenter
          .ProjectsCreateOrUpdate({
            ...where,
            location,
            tags,
            identity,
            properties: { ...mutable, devCenterId: news.devCenterId },
          })
          .pipe(Effect.retry(whileDevCenterPending));
      }
      observed = yield* waitForProvisioned(label, get, stateOf, {
        interval: "5 seconds",
        times: 60,
      });

      // Sync mutable properties, identity, and tags against observed state.
      const propsChanged = !containsValue(observed.properties, mutable);
      const identityChanged = identityDiffers(observed.identity, news.identity);
      const tagsChanged = tagsDiffer(observed.tags, tags);
      if (propsChanged || identityChanged || tagsChanged) {
        yield* devcenter.UpdateProject({
          ...where,
          tags: tagsChanged ? tags : undefined,
          identity: identityChanged ? identity : undefined,
          properties: propsChanged ? mutable : undefined,
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
        devcenter.DeleteProject({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          projectName: output.projectName,
        }),
      );
      yield* waitUntilGone(
        `dev center project ${output.projectName}`,
        getProject(subscriptionId, output.resourceGroup, output.projectName),
        { interval: "5 seconds", times: 72 },
      );
    }),

    nuke: {
      dependsOn: ["Azure.DevCenter.DevCenter", "Azure.Resources.ResourceGroup"],
    },
  });
