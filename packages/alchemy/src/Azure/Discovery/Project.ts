import * as discovery from "@distilled.cloud/azure/discovery";
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
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  createDiscoveryName,
  DISCOVERY_NAMESPACE,
  idSetKey,
  lower,
  sameLocation,
} from "./common.ts";
import { getWorkspace } from "./Workspace.ts";

export interface ProjectProps {
  /** Resource group of the parent workspace. Changing it replaces the project. */
  resourceGroup: string;
  /** Name of the parent workspace. Changing it replaces the project. */
  workspace: string;
  /**
   * Project name: 3-24 letters, digits, and hyphens. If omitted, a unique
   * name is generated from the app, stage, and logical ID. Changing it
   * replaces the project.
   */
  name?: string;
  /**
   * Azure location. Changing it replaces the project.
   * @default the parent workspace's location
   */
  location?: string;
  /**
   * ARM IDs of the Discovery storage containers the project may use.
   * Changing them replaces the project.
   */
  storageContainerIds?: string[];
  /** Default preferences that guide AI behavior in the project. */
  behaviorPreferences?: string;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface Project extends Resource<
  "Azure.Discovery.Project",
  ProjectProps,
  {
    /** Name of the project. */
    projectName: string;
    /** ARM resource ID of the project. */
    projectId: string;
    /** Name of the parent workspace. */
    workspace: string;
    /** Resource group that holds the project. */
    resourceGroup: string;
    /** Location of the project. */
    location: string;
    /** Endpoint of the Azure AI Foundry project backing this project. */
    foundryProjectEndpoint: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A Microsoft Discovery project (`Microsoft.Discovery/workspaces/projects`)
 * — a scoped research effort inside a Discovery workspace, with access to a
 * set of storage containers.
 *
 * Microsoft Discovery is a gated preview: on subscriptions without the
 * preview, ARM rejects the resource type with `InvalidResourceType`.
 *
 * @see https://learn.microsoft.com/azure/microsoft-discovery/
 *
 * ### Creating a Project
 * **Example:** Project with access to a storage container
 * ```typescript
 * const project = yield* Azure.Discovery.Project("battery", {
 *   resourceGroup: group.resourceGroupName,
 *   workspace: workspace.workspaceName,
 *   storageContainerIds: [container.storageContainerId],
 *   behaviorPreferences: "Prefer peer-reviewed sources.",
 * });
 * ```
 *
 * @resource
 */
export const Project = Resource<Project>("Azure.Discovery.Project");

const getProject = (
  subscriptionId: string,
  resourceGroupName: string,
  workspaceName: string,
  projectName: string,
) =>
  orUndefinedIfNotFound(
    discovery.GetProject({
      subscriptionId,
      resourceGroupName,
      workspaceName,
      projectName,
    }),
  ).pipe(
    Effect.catchTag("InvalidResourceType", () => Effect.succeed(undefined)),
  );

const toAttrs = (
  resourceGroup: string,
  workspace: string,
  name: string,
  observed: discovery.GetProjectResponse,
): Project["Attributes"] => ({
  projectName: name,
  projectId: observed.id ?? "",
  workspace,
  resourceGroup,
  location: observed.location,
  foundryProjectEndpoint: observed.properties?.foundryProjectEndpoint,
  tags: userTags(observed.tags),
});

export const ProjectProvider = () =>
  Provider.succeed(Project, {
    stables: [
      "projectName",
      "projectId",
      "workspace",
      "resourceGroup",
      "location",
    ],

    // Projects live inside a workspace; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        lower(news.workspace) !== lower(output.workspace) ||
        (news.name !== undefined &&
          lower(news.name) !== lower(output.projectName)) ||
        (news.location !== undefined &&
          !sameLocation(news.location, output.location)) ||
        idSetKey(news.storageContainerIds) !==
          idSetKey(olds?.storageContainerIds)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const workspace = output?.workspace ?? olds?.workspace;
      if (resourceGroup === undefined || workspace === undefined) {
        return undefined;
      }
      const name =
        output?.projectName ?? olds?.name ?? (yield* createDiscoveryName(id));
      const observed = yield* getProject(
        subscriptionId,
        resourceGroup,
        workspace,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, workspace, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, DISCOVERY_NAMESPACE);
      const { resourceGroup, workspace } = news;
      const name =
        news.name ?? output?.projectName ?? (yield* createDiscoveryName(id));
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        workspaceName: workspace,
        projectName: name,
      };
      const get = getProject(subscriptionId, resourceGroup, workspace, name);
      const ready = waitForProvisioned(
        `discovery project ${name}`,
        get,
        (project) => project.properties?.provisioningState,
        { interval: "10 seconds", times: 60 },
      );
      const settings =
        news.behaviorPreferences === undefined
          ? undefined
          : { behaviorPreferences: news.behaviorPreferences };

      // Observe.
      let observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        const location =
          news.location ??
          output?.location ??
          (yield* getWorkspace(subscriptionId, resourceGroup, workspace))
            ?.location ??
          env.location;
        yield* discovery.ProjectsCreateOrUpdate({
          ...where,
          location,
          tags,
          properties: {
            storageContainerIds: news.storageContainerIds,
            settings,
          },
        });
      }
      observed = yield* ready;

      // Sync settings and tags with a PATCH of the deltas.
      const settingsChanged =
        news.behaviorPreferences !== undefined &&
        observed.properties?.settings?.behaviorPreferences !==
          news.behaviorPreferences;
      const tagsChanged = tagsDiffer(observed.tags, tags);
      if (settingsChanged || tagsChanged) {
        yield* discovery.UpdateProject({
          ...where,
          tags: tagsChanged ? tags : undefined,
          properties: settingsChanged ? { settings } : undefined,
        });
        observed = yield* ready;
      }

      return toAttrs(resourceGroup, workspace, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        discovery.DeleteProject({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          workspaceName: output.workspace,
          projectName: output.projectName,
        }),
      ).pipe(Effect.catchTag("InvalidResourceType", () => Effect.void));
      yield* waitUntilGone(
        `discovery project ${output.projectName}`,
        getProject(
          subscriptionId,
          output.resourceGroup,
          output.workspace,
          output.projectName,
        ),
        { interval: "10 seconds", times: 60 },
      );
    }),

    nuke: {
      dependsOn: ["Azure.Discovery.Workspace", "Azure.Resources.ResourceGroup"],
    },
  });
