import { Retry as RailwayRetry } from "@distilled.cloud/railway";
import type {
  EnvironmentResponseVolumeInstancesEdgesItemNode,
  EnvironmentsResponseEdgesItemNode,
  ProjectCreateResponse,
  ProjectResponse,
  ProjectResponseBucketsEdgesItemNode,
  ProjectResponseGroupsEdgesItemNode,
  ProjectResponseServicesEdgesItemNode,
  ProjectUpdateResponse,
  ProjectsResponseEdgesItemNode,
} from "@distilled.cloud/railway";
import * as railway from "@distilled.cloud/railway";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { Unowned } from "../AdoptPolicy.ts";
import { isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import { RailwayEnvironment } from "./Environment.ts";
import {
  createRailwayName,
  matchesAlchemyPhysicalName,
  sanitizeRailwayName,
} from "./Metadata.ts";
import type { Providers } from "./Providers.ts";
import { isRailwayTransient } from "./transient.ts";

export interface ProjectProps {
  /**
   * Project name. Unique per workspace. If omitted, a unique name is
   * generated from the stack, stage and logical ID. Changing it updates
   * the project in place.
   */
  name?: string;
  /**
   * Workspace to create the project in. Defaults to the current token's
   * workspace (`me.workspace ?? me.workspaces[0]`). Changing it replaces
   * the project.
   */
  workspaceId?: string;
  /**
   * Human-readable description. Updates in place.
   */
  description?: string;
  /**
   * Name of the environment created with the project (Railway's default
   * is `production`). Create-only; ignored on update.
   */
  defaultEnvironmentName?: string;
}

export type Project = Resource<
  "Railway.Project",
  ProjectProps,
  {
    /** Railway project id. */
    projectId: string;
    /** Physical project name (unique per workspace). */
    name: string;
    /** Workspace the project lives in. */
    workspaceId: string;
    /** Primary / base environment id created with the project. */
    environmentId: string;
    /** Dashboard URL (`https://railway.com/project/{projectId}`). */
    url: string;
  },
  never,
  Providers
>;

/**
 * A Railway.Project is a workspace-scoped namespace. It owns environments
 * and services. Names are unique per workspace.
 *
 * @see https://docs.railway.com/guides/projects
 *
 * ### Create a Project
 * Alchemy generates a unique name unless you pass one. `url` is the
 * dashboard URL. A production environment is created with the project —
 * do not recreate it as an Environment resource.
 *
 * **Example:** Generated name
 * ```typescript
 * const site = yield* Railway.Project("Site");
 * ```
 *
 * :::note
 * Prefer omitting `name` in tests and CI so names stay unique and
 * reclaimable.
 * :::
 *
 * ### A stable name
 * Pass `name` when you need a stable project name. Changing it later
 * updates the project in place.
 *
 * **Example:** Explicit name
 * ```typescript
 * const site = yield* Railway.Project("Site", {
 *   name: "my-site",
 * });
 * ```
 *
 * ### Description
 * `description` is optional and updates in place.
 *
 * **Example:** With description
 * ```typescript
 * const site = yield* Railway.Project("Site", {
 *   description: "production web app",
 * });
 * ```
 *
 * ### Workspace
 * Workspace defaults to the current token. Pass `workspaceId` to pin it.
 *
 * **Example:** Pin a workspace
 * ```typescript
 * const site = yield* Railway.Project("Site", {
 *   workspaceId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
 * });
 * ```
 *
 * :::caution[Changing `workspaceId` replaces the Project]
 * The Project is created in the new workspace. The old Project is deleted.
 * :::
 *
 * ### Default environment name
 * `defaultEnvironmentName` is create-only. Railway's default is
 * `production`. Extra environments (staging) are a separate Environment
 * resource.
 *
 * **Example:** Custom default environment
 * ```typescript
 * const site = yield* Railway.Project("Site", {
 *   defaultEnvironmentName: "production",
 * });
 * ```
 *
 * ### Module-scope declarations
 * Declare the Project once. Pass it into every child. Resource-valued
 * props accept the resource or an Effect producing it.
 *
 * **Example:** Module-scope Project
 * ```typescript
 * // src/project.ts
 * import * as Railway from "alchemy/Railway";
 *
 * export const Site = Railway.Project("Site");
 * ```
 *
 * @resource
 */
export const Project = Resource<Project>("Railway.Project");

export class ProjectNotCreated extends Data.TaggedError(
  "Railway.ProjectNotCreated",
)<{
  name: string;
}> {}

type CloudProject =
  | ProjectResponse
  | ProjectCreateResponse
  | ProjectUpdateResponse
  | ProjectsResponseEdgesItemNode;

/** Workspace id from a get-by-id or list-node Project payload. */
export const workspaceIdOf = (
  project: {
    readonly workspaceId?: string | null;
    readonly workspace?: { readonly id?: string | null } | null;
  },
  fallback?: string,
): string => project.workspaceId ?? project.workspace?.id ?? fallback ?? "";

/** Primary environment id from a get-by-id or list-node Project payload. */
export const environmentIdOf = (project: {
  readonly primaryEnvironmentId?: string | null;
  readonly baseEnvironmentId?: string | null;
  readonly baseEnvironment?: { readonly id?: string | null } | null;
}): string =>
  project.primaryEnvironmentId ??
  project.baseEnvironmentId ??
  project.baseEnvironment?.id ??
  "";

const toAttrs = (
  project: CloudProject,
  fallback?: { name?: string; workspaceId?: string },
): Project["Attributes"] => {
  const name = project.name || fallback?.name || "";
  return {
    projectId: project.id,
    name,
    workspaceId: workspaceIdOf(project, fallback?.workspaceId),
    environmentId: environmentIdOf(project),
    url: `https://railway.com/project/${project.id}`,
  };
};

const resolveName = (id: string, name: string | undefined, existing?: string) =>
  Effect.gen(function* () {
    if (name !== undefined) return sanitizeRailwayName(name);
    if (existing !== undefined) return existing;
    return yield* createRailwayName(id);
  });

const isGone = (project: CloudProject | undefined) =>
  project === undefined || project.deletedAt != null;

const getById = (projectId: string) =>
  railway.project({ id: projectId }).pipe(
    Effect.map((project) => (isGone(project) ? undefined : project)),
    Effect.catchTag(["RailwayNotFound", "NotFound"], () =>
      Effect.succeed(undefined),
    ),
  );

const currentWorkspaceId = Effect.fn(function* () {
  const env = yield* yield* RailwayEnvironment;
  return env.workspaceId;
});

/**
 * Railway allows one project create per workspace every 30 seconds.
 * Concurrent stacks (the live suite) stampede that cap; hold a process
 * slot, retry the typed tag, and wait out the window after a success
 * so the next waiter does not 429.
 */
const projectCreateSlot = Semaphore.makeUnsafe(1);

export const createProject = (input: {
  name: string;
  workspaceId: string;
  description?: string;
  defaultEnvironmentName?: string;
}) =>
  Semaphore.withPermits(
    projectCreateSlot,
    1,
  )(
    railway
      .projectCreate({
        input: {
          name: input.name,
          workspaceId: input.workspaceId,
          ...(input.description !== undefined
            ? { description: input.description }
            : {}),
          ...(input.defaultEnvironmentName !== undefined
            ? { defaultEnvironmentName: input.defaultEnvironmentName }
            : {}),
        },
      })
      .pipe(
        RailwayRetry.none,
        Effect.retry({
          while: isRailwayTransient,
          schedule: Schedule.spaced("31 seconds"),
          times: 8,
        }),
        Effect.tap(() => Effect.sleep("31 seconds")),
      ),
  );

const findByName = (workspaceId: string, name: string) =>
  railway.projects
    .items({ workspaceId, first: 50, includeDeleted: false })
    .pipe(
      Stream.filter((project) => !isGone(project) && project.name === name),
      Stream.take(1),
      Stream.runHead,
      Effect.map((option) =>
        option._tag === "Some" ? option.value : undefined,
      ),
    );

/**
 * List-path GraphQL: distilled retry stays default (mutations need it).
 * Nuke `list()` must not sit on Retry-After — fail fast and return
 * `fallback`. One in-flight list call at a time so 16 provider scans
 * do not stampede the same workspace.
 */
const listGraphqlSlot = Semaphore.makeUnsafe(1);

export const listGraphql = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  fallback: A,
): Effect.Effect<A, never, R> =>
  Semaphore.withPermits(
    listGraphqlSlot,
    1,
  )(
    effect.pipe(
      RailwayRetry.none,
      Effect.timeout("8 seconds"),
      Effect.result,
      Effect.map((result) =>
        Result.isSuccess(result) ? result.success : fallback,
      ),
    ),
  );

const fetchOwnedProjects = Effect.fn(function* () {
  const workspaceId = yield* currentWorkspaceId();
  const projects = yield* listGraphql(
    railway.projects
      .items({ workspaceId, first: 50, includeDeleted: false })
      .pipe(
        Stream.runCollect,
        Effect.map((chunk) => Array.from(chunk)),
      ),
    [] as ProjectsResponseEdgesItemNode[],
  );
  return projects
    .filter(
      (project) => !isGone(project) && matchesAlchemyPhysicalName(project.name),
    )
    .map((project) => toAttrs(project, { workspaceId }));
});

const volumeInstancesOf = (
  env: EnvironmentsResponseEdgesItemNode,
): EnvironmentResponseVolumeInstancesEdgesItemNode[] =>
  env.volumeInstances.edges.map((edge) => edge.node);

/**
 * One cloud snapshot per owned project. Concurrent `list()` (nuke) shares
 * this so every resource type does not re-hit `project({id})` /
 * `environments`. Distilled retry is off — list must not sit on Retry-After.
 *
 * Do not `environment({id})` here: that query still selects
 * `canvasGroupRefs` / `meta` and is what made nuke spin.
 */
export interface OwnedEnv {
  id: string;
  name: string;
  projectId: string;
  deletedAt: string | null;
  isEphemeral: boolean;
  volumeInstances: EnvironmentResponseVolumeInstancesEdgesItemNode[];
}

export interface OwnedCloud {
  attrs: Project["Attributes"];
  services: ProjectResponseServicesEdgesItemNode[];
  buckets: ProjectResponseBucketsEdgesItemNode[];
  groups: ProjectResponseGroupsEdgesItemNode[];
  environments: OwnedEnv[];
}

const fetchOwnedCloud = Effect.fn(function* () {
  const projects = yield* fetchOwnedProjects();
  return yield* Effect.forEach(
    projects,
    (attrs) =>
      Effect.gen(function* () {
        const live = yield* listGraphql(
          railway.project({ id: attrs.projectId }).pipe(
            Effect.map((project) =>
              project.deletedAt != null ? undefined : project,
            ),
            Effect.catchTag(["RailwayNotFound", "NotFound"], () =>
              Effect.succeed(undefined),
            ),
          ),
          undefined,
        );
        const envRows = yield* listGraphql(
          railway.environments
            .items({ projectId: attrs.projectId, first: 50 })
            .pipe(
              Stream.filter((env) => env.deletedAt == null),
              Stream.runCollect,
              Effect.map((chunk) => Array.from(chunk)),
              Effect.catchTag(["RailwayNotFound", "NotFound"], () =>
                Effect.succeed([] as EnvironmentsResponseEdgesItemNode[]),
              ),
            ),
          [] as EnvironmentsResponseEdgesItemNode[],
        );
        return {
          attrs,
          services:
            live?.services.edges
              .map((edge) => edge.node)
              .filter((node) => node.deletedAt == null) ?? [],
          buckets: live?.buckets.edges.map((edge) => edge.node) ?? [],
          groups: live?.groups.edges.map((edge) => edge.node) ?? [],
          environments: envRows.map((env) => ({
            id: env.id,
            name: env.name,
            projectId: env.projectId,
            deletedAt: env.deletedAt,
            isEphemeral: env.isEphemeral,
            volumeInstances: volumeInstancesOf(env),
          })),
        } satisfies OwnedCloud;
      }),
    { concurrency: 1 },
  );
});

/**
 * Concurrent `list()` coalesces to one scan. Sequential calls refetch so
 * create/delete tests see fresh rows. Always complete the deferred and
 * clear inflight — a timed-out leader must not leave waiters parked.
 */
const ownedCloudInflight = Ref.makeUnsafe<
  Deferred.Deferred<OwnedCloud[], unknown> | undefined
>(undefined);

export const listOwnedCloud = Effect.fn(function* () {
  const [leader, deferred] = yield* Ref.modify(ownedCloudInflight, (cur) => {
    if (cur !== undefined) return [[false, cur] as const, cur];
    const next = Deferred.makeUnsafe<OwnedCloud[], unknown>();
    return [[true, next] as const, next];
  });
  if (!leader) {
    return yield* Deferred.await(deferred);
  }
  const exit = yield* Effect.exit(fetchOwnedCloud()).pipe(
    Effect.tap((next) => Deferred.done(deferred, next)),
    Effect.ensuring(Ref.set(ownedCloudInflight, undefined)),
  );
  return yield* exit;
});

/**
 * Projects in the current token's workspace that Alchemy owns. Used by
 * {@link Project} `list()` and by child resources so nuke never enumerates
 * the whole workspace unfiltered.
 */
export const listOwnedProjects = Effect.fn(function* () {
  const cloud = yield* listOwnedCloud();
  return cloud.map((row) => row.attrs);
});

export const ProjectProvider = () =>
  Provider.succeed(Project, {
    stables: ["projectId", "workspaceId", "environmentId"],

    diff: Effect.fn(function* ({ news, output }) {
      if (news === undefined || !isResolved(news)) return undefined;
      if (output === undefined) return undefined;
      const workspaceChanged =
        news.workspaceId !== undefined &&
        news.workspaceId !== output.workspaceId;
      if (workspaceChanged) {
        return { action: "replace" as const };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const name = yield* resolveName(id, olds?.name, output?.name);
      const workspaceId =
        output?.workspaceId ??
        olds?.workspaceId ??
        (yield* currentWorkspaceId());
      const found =
        (output?.projectId !== undefined
          ? yield* getById(output.projectId)
          : undefined) ?? (yield* findByName(workspaceId, name));
      if (found === undefined) return undefined;
      const attrs = toAttrs(found, { name, workspaceId });
      if (output !== undefined) return attrs;
      return matchesAlchemyPhysicalName(found.name) ? attrs : Unowned(attrs);
    }),

    list: listOwnedProjects,

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const props = news ?? {};
      const name = yield* resolveName(id, props.name, output?.name);
      const workspaceId =
        props.workspaceId ??
        output?.workspaceId ??
        (yield* currentWorkspaceId());

      let current: CloudProject | undefined =
        output?.projectId !== undefined
          ? yield* getById(output.projectId)
          : undefined;
      if (current === undefined) {
        current = yield* findByName(workspaceId, name);
      }

      if (current === undefined) {
        const created = yield* createProject({
          name,
          workspaceId,
          ...(props.description !== undefined
            ? { description: props.description }
            : {}),
          ...(props.defaultEnvironmentName !== undefined
            ? { defaultEnvironmentName: props.defaultEnvironmentName }
            : {}),
        }).pipe(
          Effect.catchTag("RailwayValidationError", () =>
            Effect.succeed(undefined),
          ),
        );
        current = created ?? (yield* findByName(workspaceId, name));
      }

      if (current === undefined || isGone(current)) {
        return yield* new ProjectNotCreated({ name });
      }

      const nameChanged = current.name !== name;
      const observedDescription = current.description ?? undefined;
      const descriptionChanged =
        props.description !== undefined &&
        props.description !== observedDescription;
      if (nameChanged || descriptionChanged) {
        current = yield* railway.projectUpdate({
          id: current.id,
          input: {
            ...(nameChanged ? { name } : {}),
            ...(descriptionChanged ? { description: props.description } : {}),
          },
        });
      }

      return toAttrs(current, { name, workspaceId });
    }),

    delete: Effect.fn(function* ({ output }) {
      const projectId = output.projectId;
      if (projectId.length === 0) return;
      yield* railway
        .projectDelete({ id: projectId })
        .pipe(
          Effect.catchTag(["RailwayNotFound", "NotFound"], () => Effect.void),
        );
      yield* getById(projectId).pipe(
        Effect.map((project) => project === undefined),
        Effect.repeat({
          schedule: Schedule.spaced("1 second"),
          until: (gone) => gone,
          times: 8,
        }),
      );
    }),
  });
