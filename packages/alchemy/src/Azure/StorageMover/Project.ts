import * as storagemover from "@distilled.cloud/azure/storagemover";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  createMoverName,
  DELETE_BUDGET,
  describe,
  isOwnedByDescription,
  userDescription,
} from "./Common.ts";

export interface ProjectProps {
  /** Resource group of the Storage Mover. Changing it replaces the project. */
  resourceGroup: string;
  /** Storage Mover that holds the project. Changing it replaces the project. */
  storageMover: string;
  /**
   * Name of the project: 1-64 letters, digits, `-` and `_`, starting with a
   * letter or digit. If omitted, a unique name is generated from the app,
   * stage, and logical ID. Changing it replaces the project.
   */
  name?: string;
  /**
   * Description of the project. Alchemy appends an ownership marker
   * (`[alchemy <stack>/<stage>/<id>]`) because projects have no tags.
   */
  description?: string;
}

export interface Project extends Resource<
  "Azure.StorageMover.Project",
  ProjectProps,
  {
    /** Name of the project. */
    projectName: string;
    /** Storage Mover that holds the project. */
    storageMover: string;
    /** Resource group of the Storage Mover. */
    resourceGroup: string;
    /** ARM resource ID of the project. */
    projectId: string;
    /** Description of the project (ownership marker stripped). */
    description: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A Storage Mover project — a group of job definitions that migrate related
 * data, e.g. one per source server or workload.
 *
 * Projects have no tags, so Alchemy records ownership as a marker at the end
 * of the description.
 *
 * @see https://learn.microsoft.com/azure/storage-mover/project-manage
 *
 * ### Creating a Project
 * **Example:** Project in a Storage Mover
 * ```typescript
 * const mover = yield* Azure.StorageMover.StorageMover("mover", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * const project = yield* Azure.StorageMover.Project("file-servers", {
 *   resourceGroup: group.resourceGroupName,
 *   storageMover: mover.storageMoverName,
 *   description: "Migrate the on-premises file servers",
 * });
 * ```
 *
 * @resource
 */
export const Project = Resource<Project>("Azure.StorageMover.Project");

const getProject = (
  subscriptionId: string,
  resourceGroupName: string,
  storageMoverName: string,
  projectName: string,
) =>
  orUndefinedIfNotFound(
    storagemover.GetProject({
      subscriptionId,
      resourceGroupName,
      storageMoverName,
      projectName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  storageMover: string,
  name: string,
  project: storagemover.GetProjectResponse,
): Project["Attributes"] => ({
  projectName: name,
  storageMover,
  resourceGroup,
  projectId: project.id ?? "",
  description: userDescription(project.properties?.description),
});

export const ProjectProvider = () =>
  Provider.succeed(Project, {
    stables: ["projectName", "storageMover", "resourceGroup", "projectId"],

    // Projects are deleted with their Storage Mover.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        news.storageMover.toLowerCase() !== output.storageMover.toLowerCase() ||
        (news.name !== undefined &&
          news.name.toLowerCase() !== output.projectName.toLowerCase())
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const storageMover = output?.storageMover ?? olds?.storageMover;
      if (resourceGroup === undefined || storageMover === undefined) {
        return undefined;
      }
      const name =
        output?.projectName ?? olds?.name ?? (yield* createMoverName(id));
      const observed = yield* getProject(
        subscriptionId,
        resourceGroup,
        storageMover,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, storageMover, name, observed);
      return (yield* isOwnedByDescription(id, observed.properties?.description))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.StorageMover");
      const { resourceGroup, storageMover } = news;
      const name =
        news.name ?? output?.projectName ?? (yield* createMoverName(id));
      const description = yield* describe(id, news.description);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        storageMoverName: storageMover,
        projectName: name,
      };
      const get = getProject(subscriptionId, resourceGroup, storageMover, name);

      // Observe.
      const observed = yield* get;

      // Ensure, then sync the description against the observed project.
      if (observed === undefined) {
        yield* storagemover.ProjectsCreateOrUpdate({
          ...where,
          properties: { description },
        });
      } else if (observed.properties?.description !== description) {
        yield* storagemover.UpdateProject({
          ...where,
          properties: { description },
        });
      }

      const fresh = yield* waitForProvisioned(
        `storage mover project ${name}`,
        get,
        (project) => project.properties?.provisioningState,
      );
      return toAttrs(resourceGroup, storageMover, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        storagemover.DeleteProject({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          storageMoverName: output.storageMover,
          projectName: output.projectName,
        }),
      );
      yield* waitUntilGone(
        `storage mover project ${output.projectName}`,
        getProject(
          subscriptionId,
          output.resourceGroup,
          output.storageMover,
          output.projectName,
        ),
        DELETE_BUDGET,
      );
    }),
  });
