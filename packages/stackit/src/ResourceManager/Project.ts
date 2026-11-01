import * as resourceManager from "@distilled.cloud/stackit/resource_manager";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { StackitEnvironment } from "../Environment.ts";
import { hasUnresolvedTrigger } from "../internal/diff.ts";
import { waitFor, waitUntilGone } from "../internal/wait.ts";
import { desiredLabels, hasAlchemyLabels, isAlchemyOwned, stripInternalLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  containerName,
  desiredParent,
  isParent,
  labelsUpdate,
  listChildProjects,
  listFolderTree,
} from "./internal.ts";

/** A member granted a role on the project when it is created. */
export interface ProjectMember {
  /**
   * Role on the project, e.g. `owner`, `editor` or `reader`.
   */
  role: string;
  /**
   * The member: a user's e-mail address, or a service account's e-mail.
   */
  subject: string;
}

export type ProjectProps = {
  /**
   * Project name. 2-41 characters (letters, digits, `_`, `+`, `&`, `-`, single
   * spaces), starting with a letter or digit. Renaming updates the project in
   * place. If omitted, a unique name is generated from the stack, stage and
   * logical id.
   */
  name?: string;
  /**
   * Container id (or UUID) of the parent: an organization or a folder.
   * Changing it moves the project to the new parent in place.
   * Defaults to the profile's organization.
   */
  parentId?: string;
  /**
   * E-mail of the user who owns the project. Shorthand for a
   * `{ subject: owner, role: "owner" }` entry in `members`. STACKIT requires
   * at least one *user* (not a service account) among the initial members,
   * so set `owner` (or a user in `members`) when deploying with a service
   * account key. Only used when the project is created; manage membership
   * afterwards with the IAM resources.
   */
  owner?: string;
  /**
   * Initial members of the project. Only used when the project is created;
   * changing it later has no effect on the project.
   */
  members?: ProjectMember[];
  /**
   * Id of the STACKIT Network Area (SNA) to create the project in. Sets the
   * create-only `networkArea` label. Without it the project is created with
   * the `scope: PUBLIC` label. Changing it replaces the project, deleting
   * every resource in it.
   */
  networkAreaId?: string;
  /**
   * User labels (`key: value`). Keys are 1-63 characters (letters, digits,
   * `-`, `_`, `.`, optionally prefixed by a DNS subdomain and `/`); values
   * at most 63 characters. Alchemy ownership labels (`alchemy.*`) are merged
   * in automatically.
   */
  labels?: Record<string, string>;
};

export type Project = Resource<
  "Stackit.ResourceManager.Project",
  ProjectProps,
  {
    /** Project UUID; the `projectId` every project-scoped STACKIT API takes. */
    projectId: string;
    /** Globally unique, user-friendly project id (e.g. `my-project-1a2b3c`). */
    containerId: string;
    /** Project name. */
    name: string;
    /** Container id of the parent organization or folder. */
    parentId: string;
    /** Type of the parent container. */
    parentType: resourceManager.ParentType;
    /** Lifecycle state; `ACTIVE` after every successful deploy. */
    lifecycleState: resourceManager.LifecycleState;
    /** Network Area the project belongs to, from its `networkArea` label. */
    networkAreaId: string | undefined;
    /** Project labels, without Alchemy's ownership labels. */
    labels: Record<string, string>;
    /** RFC 3339 creation timestamp. */
    creationTime: string;
  },
  never,
  Providers
>;

/**
 * A STACKIT project: the container that owns every project-scoped resource
 * (networks, servers, DNS zones, buckets, ...) and their billing.
 *
 * Projects live in an organization, directly or inside a folder. Creating
 * one needs organization-level permissions (`resource-manager.project.create`
 * on the parent). Creation and deletion are asynchronous; Alchemy waits
 * until the project is `ACTIVE`, and on delete until it is gone. Deleting a
 * project deletes everything inside it.
 *
 * The project id other STACKIT resources take is `project.projectId`. Every
 * other STACKIT resource defaults to the profile's project, so pass
 * `projectId: project.projectId` to deploy into a project this stack
 * creates.
 *
 * Ownership is marked with `alchemy.stack` / `alchemy.stage` / `alchemy.id`
 * labels; `alchemy unsafe nuke` only deletes projects carrying them and
 * never deletes the profile's own project.
 *
 * ### Creating a project
 * **Example:** Project owned by a user, in the profile's organization
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const project = yield* Stackit.ResourceManager.Project("App", {
 *   owner: "jane.doe@example.com",
 * });
 * ```
 *
 * **Example:** Named project with labels
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const project = yield* Stackit.ResourceManager.Project("App", {
 *   name: "checkout-prod",
 *   owner: "jane.doe@example.com",
 *   labels: { team: "payments", env: "prod" },
 * });
 * ```
 *
 * ### Placing a project in a folder
 * **Example:** Project inside a folder this stack creates
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const folder = yield* Stackit.ResourceManager.Folder("Payments", {});
 * const project = yield* Stackit.ResourceManager.Project("App", {
 *   parentId: folder.containerId,
 *   owner: "jane.doe@example.com",
 * });
 * ```
 *
 * Changing `parentId` later moves the project; it is not recreated.
 *
 * ### Deploying into the new project
 * **Example:** Pass the project id to project-scoped resources
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const project = yield* Stackit.ResourceManager.Project("App", {
 *   owner: "jane.doe@example.com",
 * });
 * yield* Stackit.ServiceEnablement.Service("Ske", {
 *   serviceId: "cloud.stackit.ske",
 *   projectId: project.projectId,
 * });
 * ```
 *
 * ### Network Areas
 * **Example:** Project attached to a STACKIT Network Area
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const project = yield* Stackit.ResourceManager.Project("Private", {
 *   owner: "jane.doe@example.com",
 *   networkAreaId: "00000000-0000-0000-0000-000000000000",
 * });
 * ```
 *
 * The `networkArea` label is immutable: changing `networkAreaId` replaces
 * the project and deletes everything in it.
 *
 * @resource
 * @product STACKIT Resource Manager
 * @category Resource Manager
 */
export const Project = Resource<Project>("Stackit.ResourceManager.Project");

/** Label STACKIT reads the project's Network Area from; immutable after create. */
const NETWORK_AREA_LABEL = "networkArea";
/** Label that marks a project outside any Network Area. */
const SCOPE_LABEL = "scope";
/** Labels only set at creation and never synced afterwards. */
const CREATE_ONLY_LABELS = [NETWORK_AREA_LABEL, SCOPE_LABEL];

type ObservedProject = resourceManager.Project | resourceManager.GetProjectResponse;

const toAttrs = (project: ObservedProject) => {
  const networkAreaId = project.labels?.[NETWORK_AREA_LABEL];
  return {
    projectId: project.projectId,
    containerId: project.containerId,
    name: project.name,
    parentId: project.parent.containerId,
    parentType: project.parent.type,
    lifecycleState: project.lifecycleState,
    networkAreaId: networkAreaId === undefined || networkAreaId === "" ? undefined : networkAreaId,
    labels: stripInternalLabels(project.labels),
    creationTime: project.creationTime,
  };
};

const getProject = (id: string) =>
  resourceManager.getProject({ id }).pipe(Effect.catchTag("NotFound", () => Effect.undefined));

const waitUntilProjectGone = (id: string) =>
  waitUntilGone({
    resource: `STACKIT project ${id}`,
    read: getProject(id),
    state: (project) => project.lifecycleState,
    // Deletion is asynchronous and removes every resource in the project.
    timeout: "15 minutes",
    interval: "5 seconds",
    maxInterval: "30 seconds",
  });

/**
 * The Alchemy-owned project for logical id `id` under `parentId`, if any. The
 * Network Area must match too: it can't change in place, so a project in
 * another area is the generation being replaced, which garbage collection
 * deletes, along with everything in it, once the replacement exists.
 */
const findOwned = Effect.fn(function* (
  id: string,
  parentId: string,
  networkAreaId: string | undefined,
) {
  for (const project of yield* listChildProjects(parentId)) {
    if (project.lifecycleState === "DELETING") continue;
    if (toAttrs(project).networkAreaId !== networkAreaId) continue;
    if (yield* hasAlchemyLabels(id, project.labels)) return project;
  }
  return undefined;
});

/**
 * Observe the project: by the cached id first, then by ownership labels
 * under the parent. A project that is being deleted is waited out and
 * reported missing.
 */
const observe = Effect.fn(function* (input: {
  id: string;
  projectId: string | undefined;
  parentId: string;
  networkAreaId: string | undefined;
}) {
  if (input.projectId !== undefined) {
    const byId = yield* getProject(input.projectId);
    if (byId !== undefined && byId.lifecycleState !== "DELETING") return byId;
    if (byId !== undefined) yield* waitUntilProjectGone(input.projectId);
  }
  return yield* findOwned(input.id, input.parentId, input.networkAreaId);
});

export const ProjectProvider = () =>
  Provider.succeed(Project, {
    stables: ["projectId", "containerId", "creationTime"],
    // A project's resources are deleted with it, but the folder holding it
    // must outlive the project's asynchronous deletion.
    nuke: { dependsOn: ["Stackit.ResourceManager.Folder"] },

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (output === undefined) return undefined;
      // An unresolved area is one being replaced or created. Delete-first, because
      // it can resolve to the current area, and a create-first replacement would
      // then reclaim the old project, which garbage collection deletes.
      if (hasUnresolvedTrigger<ProjectProps>(news, ["networkAreaId"])) {
        return { action: "replace", deleteFirst: true } as const;
      }
      if (!isResolved(news)) return undefined;
      // `networkArea` is immutable. On adoption (no olds) an unset prop
      // keeps whatever network area the project already has.
      if (
        (olds !== undefined || news.networkAreaId !== undefined) &&
        (news.networkAreaId ?? undefined) !== output.networkAreaId
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output, previous }) {
      if (output?.projectId !== undefined) {
        const byId = yield* getProject(output.projectId);
        if (byId === undefined || byId.lifecycleState === "DELETING") return undefined;
        return toAttrs(byId);
      }
      const parentId = yield* desiredParent(olds?.parentId);
      const owned = yield* findOwned(id, parentId, olds?.networkAreaId);
      if (owned !== undefined) return toAttrs(owned);
      // A same-named project without our labels: report it, but as foreign.
      // The generation being replaced isn't: it keeps its name until it's gone.
      if (olds?.name === undefined) return undefined;
      const children = yield* listChildProjects(parentId);
      const named = children.find(
        (project) =>
          project.name === olds.name &&
          project.lifecycleState !== "DELETING" &&
          project.projectId !== previous?.projectId,
      );
      return named === undefined ? undefined : Unowned(toAttrs(named));
    }),

    list: Effect.fn(function* () {
      const env = yield* StackitEnvironment.current;
      // A profile without an organization has nothing in scope to enumerate.
      const organizationId = env.organizationId;
      if (organizationId === undefined) return [];
      const folders = yield* listFolderTree(organizationId);
      const projects: ReturnType<typeof toAttrs>[] = [];
      for (const container of [organizationId, ...folders.map((folder) => folder.containerId)]) {
        for (const project of yield* listChildProjects(container)) {
          // Never hand the profile's own project (the account root every
          // other resource deploys into) to nuke.
          if (project.projectId === env.projectId) continue;
          if (project.lifecycleState === "DELETING") continue;
          if (isAlchemyOwned(project.labels)) projects.push(toAttrs(project));
        }
      }
      return projects;
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const name = yield* containerName(id, news.name);
      const parentId = yield* desiredParent(news.parentId);
      const labels = yield* desiredLabels(id, news.labels);

      // 1. Observe
      let current: ObservedProject | undefined = yield* observe({
        id,
        projectId: output?.projectId,
        parentId,
        networkAreaId: news.networkAreaId,
      });

      // 2. Ensure
      if (current === undefined) {
        const members = [
          ...(news.owner === undefined ? [] : [{ subject: news.owner, role: "owner" }]),
          ...(news.members ?? []),
        ];
        current = yield* resourceManager.createProject({
          containerParentId: parentId,
          name,
          labels: {
            ...(news.networkAreaId === undefined
              ? { [SCOPE_LABEL]: "PUBLIC" }
              : { [NETWORK_AREA_LABEL]: news.networkAreaId }),
            ...labels,
          },
          members: members.length > 0 ? members : undefined,
        });
      }

      const projectId = current.projectId;
      if (current.lifecycleState !== "ACTIVE") {
        current = yield* waitFor({
          resource: `STACKIT project ${name}`,
          // Not visible yet right after create: keep polling.
          read: getProject(projectId),
          ready: (project) => project?.lifecycleState === "ACTIVE",
          failed: (project) =>
            project?.lifecycleState === "DELETING" || project?.lifecycleState === "INACTIVE"
              ? `project is ${project.lifecycleState}`
              : undefined,
          state: (project) => project?.lifecycleState ?? "not visible",
          timeout: "10 minutes",
          interval: "2 seconds",
          maxInterval: "15 seconds",
        }).pipe(Effect.map((project) => project!));
      }

      // 3. Sync name, parent and labels against the observed project.
      const labelPatch = labelsUpdate(current.labels, labels, CREATE_ONLY_LABELS);
      const rename = current.name !== name;
      const move = !isParent(current.parent, parentId);
      if (rename || move || labelPatch !== undefined) {
        current = yield* resourceManager.partialUpdateProject({
          id: projectId,
          name: rename ? name : undefined,
          containerParentId: move ? parentId : undefined,
          labels: labelPatch,
        });
      }

      // 4. Return
      return toAttrs(current);
    }),

    delete: Effect.fn(function* ({ output }) {
      const current = yield* getProject(output.projectId);
      if (current === undefined) return;
      if (current.lifecycleState !== "DELETING") {
        yield* resourceManager.deleteProject({ id: output.projectId }).pipe(
          // A concurrent delete already started: fine. Anything else is real.
          Effect.catchTag("Conflict", (error) =>
            getProject(output.projectId).pipe(
              Effect.flatMap((project) =>
                project === undefined || project.lifecycleState === "DELETING"
                  ? Effect.void
                  : Effect.fail(error),
              ),
            ),
          ),
        );
      }
      yield* waitUntilProjectGone(output.projectId);
    }),
  });
