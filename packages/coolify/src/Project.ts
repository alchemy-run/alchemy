import * as Coolify from "@distilled.cloud/coolify";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { isGeneratedName, looksGenerated, resolveName } from "./internal/naming.ts";
import type { Providers } from "./Providers.ts";

export interface ProjectProps {
  /**
   * Project name shown in the Coolify dashboard. If omitted, a unique name
   * is generated from the stack, stage and logical ID. Renaming updates the
   * project in place.
   */
  name?: string;
  /**
   * Free-form description shown in the dashboard. Updates in place.
   */
  description?: string;
}

export type Project = Resource<
  "Coolify.Project",
  ProjectProps,
  {
    /** Project UUID. Pass it as `project` to environments, applications and databases. */
    projectUuid: string;
    /** Project name. */
    name: string;
    /** Project description, if any. */
    description: string | undefined;
  },
  never,
  Providers,
  ProjectLookup
>;

/** Props for {@link Project.lookup}: find a project this stack doesn't manage. */
export interface ProjectLookup {
  /** Project UUID. */
  projectUuid: string;
}

/**
 * A Coolify project: the top-level folder that groups environments and the
 * applications, databases and services inside them.
 *
 * Coolify creates a `production` environment with every project. Declare
 * further environments with {@link Environment}, or deploy straight into
 * `production` by passing `environmentName: "production"` to an
 * application or database.
 *
 * Coolify has no labels on projects, so Alchemy recognises the projects it
 * created by their generated name. A project you name yourself and that
 * already exists is reported as unowned and needs `--adopt`.
 *
 * Creating a project needs a token with access to all resources in the
 * team: a token limited to selected projects gets `ActionNotAuthorized`.
 * With such a token, reference its project with {@link Project.lookup} and
 * manage environments and resources inside it.
 *
 * Coolify refuses to delete a project that still has resources. Alchemy
 * deletes a stack's applications and databases before their project, and
 * retries the project delete briefly while Coolify finishes removing them.
 *
 * @see https://coolify.io/docs/knowledge-base/projects
 *
 * ### Creating a Project
 * **Example:** Project with a generated name
 * ```typescript
 * const project = yield* Coolify.Project("app", {});
 * ```
 *
 * **Example:** Named project with a description
 * ```typescript
 * const project = yield* Coolify.Project("shop", {
 *   name: "shop",
 *   description: "Storefront and its databases",
 * });
 * ```
 *
 * ### Deploying into a Project
 * **Example:** An application in the project's default environment
 * ```typescript
 * const project = yield* Coolify.Project("app", {});
 *
 * const web = yield* Coolify.Application("web", {
 *   project: project.projectUuid,
 *   environmentName: "production",
 *   server: "<server-uuid>",
 *   image: "nginx:1.27-alpine",
 *   ports: [80],
 * });
 * ```
 *
 * ### Looking up an existing project
 * `Project.lookup` references a project Alchemy doesn't manage. It is read
 * during plan and deploy, and never created, updated or deleted.
 *
 * **Example:** Deploy into a project created in the dashboard
 * ```typescript
 * const shared = Coolify.Project.lookup({ projectUuid: "k0s8w4gc8owo4o0" });
 *
 * const preview = yield* Coolify.Environment("preview", {
 *   project: shared.projectUuid,
 * });
 * ```
 *
 * @resource
 * @product Project
 */
export const Project = Resource<Project>("Coolify.Project");

/** Coolify returned a project without the fields Alchemy needs. */
export class ProjectUnexpectedResponse extends Data.TaggedError(
  "Coolify.ProjectUnexpectedResponse",
)<{ readonly message: string }> {}

const toAttrs = (project: Coolify.Project) =>
  Effect.gen(function* () {
    if (!project.uuid || project.name === undefined) {
      return yield* new ProjectUnexpectedResponse({
        message: "Coolify returned a project without a uuid or name",
      });
    }
    return {
      projectUuid: project.uuid,
      name: project.name,
      description: project.description ?? undefined,
    } satisfies Project["Attributes"];
  });

export const ProjectProvider = () =>
  Provider.effect(
    Project,
    Effect.gen(function* () {
      const getProject = yield* Coolify.getProject;
      const listProjects = yield* Coolify.listProjects;
      const createProject = yield* Coolify.createProject;
      const updateProject = yield* Coolify.updateProjectByUuid;
      const deleteProject = yield* Coolify.deleteProject;

      const observe = (uuid: string) =>
        getProject({ uuid }).pipe(Effect.catchTag("NotFound", () => Effect.undefined));

      const findByName = (name: string) =>
        listProjects({}).pipe(Effect.map((projects) => projects.find((p) => p.name === name)));

      return {
        stables: ["projectUuid"],

        list: () =>
          Effect.gen(function* () {
            const projects = yield* listProjects({});
            return yield* Effect.forEach(
              projects.filter((project) => looksGenerated(project.name)),
              toAttrs,
            );
          }),

        diff: Effect.fn(function* ({ id, news, output }) {
          if (!isResolved(news) || output === undefined) return undefined;
          const name = yield* resolveName(id, news.name, output.name);
          if (name !== output.name || (news.description ?? undefined) !== output.description) {
            return { action: "update" } as const;
          }
          return undefined;
        }),

        read: Effect.fn(function* ({ id, olds, output }) {
          if (output?.projectUuid) {
            const project = yield* observe(output.projectUuid);
            return project ? yield* toAttrs(project) : undefined;
          }
          // State was lost after a create: find the project by the name this
          // resource would have, and claim it only when we generated it.
          const name = yield* resolveName(id, olds?.name);
          const project = yield* findByName(name);
          if (!project) return undefined;
          const attrs = yield* toAttrs(project);
          return (yield* isGeneratedName(id, project.name)) ? attrs : Unowned(attrs);
        }),

        lookup: Effect.fn(function* ({ projectUuid }) {
          const project = yield* observe(projectUuid);
          return project ? yield* toAttrs(project) : undefined;
        }),

        reconcile: Effect.fn(function* ({ id, news, output }) {
          const name = yield* resolveName(id, news.name, output?.name);
          const description = news.description;

          // Observe — the uuid in state is a cache; the project may be gone.
          let project = output?.projectUuid ? yield* observe(output.projectUuid) : undefined;

          // Ensure — create when missing. Project names are not unique in
          // Coolify, so there is no conflict to tolerate.
          if (project === undefined) {
            const created = yield* createProject({ name, description });
            if (!created.uuid) {
              return yield* new ProjectUnexpectedResponse({
                message: "Coolify did not return the new project's uuid",
              });
            }
            project = yield* getProject({ uuid: created.uuid });
          }

          // Sync — name and description, against what Coolify reports.
          if (project.name !== name || (project.description ?? undefined) !== description) {
            yield* updateProject({ uuid: project.uuid!, name, description: description ?? "" });
            project = yield* getProject({ uuid: project.uuid! });
          }

          return yield* toAttrs(project);
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* deleteProject({ uuid: output.projectUuid }).pipe(
            // Resources deleted just before the project are removed by a
            // queued job; wait for the project to empty.
            Effect.retry({
              while: (e) => e._tag === "ProjectHasResources",
              schedule: Schedule.spaced("3 seconds"),
              times: 15,
            }),
            Effect.catchTag("NotFound", () => Effect.void),
          );
        }),
      };
    }),
  );
