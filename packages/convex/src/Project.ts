import * as convex from "@distilled.cloud/convex/convex";
import { Unowned } from "alchemy/AdoptPolicy";
import { deepEqual, isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import { Stack } from "alchemy/Stack";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { team } from "./Credentials.ts";
import { createOnce } from "./internal/retry.ts";
import { isOwnershipTag, ownershipTag } from "./internal/tags.ts";
import { assertTeam } from "./internal/team.ts";
import type { Providers } from "./Providers.ts";

/** Convex deletes a project's deployments with it, so this resource refuses while a prod one exists. */
export class ProjectHasProductionDeployment extends Data.TaggedError(
  "ProjectHasProductionDeployment",
)<{
  readonly message: string;
  readonly projectId: number;
}> {}

export interface ProjectProps {
  /**
   * Project name, as shown in the dashboard. Spaces and punctuation are
   * allowed. If omitted, a unique name is generated from the stack, stage and
   * logical ID. Changing it renames the project in place.
   */
  name?: string;
  /**
   * URL slug. Convex derives one from the name at creation. A later rename
   * leaves the slug alone unless this is set.
   */
  slug?: string;
  /**
   * Project tags. Letters, numbers, `-` and `_` only. An ownership tag is
   * always added beside these.
   */
  tags?: string[];
}

export interface ProjectAttributes {
  /** Numeric project ID. */
  projectId: number;
  /** Project name. */
  name: string;
  /** URL slug. */
  slug: string;
  /** Numeric ID of the owning team. */
  teamId: number;
  /** Slug of the owning team. */
  teamSlug: string;
  /** Tags on the project, including the ownership tag. */
  tags: string[];
}

export type Project = Resource<"Convex.Project", ProjectProps, ProjectAttributes, never, Providers>;

/**
 * A Convex project. It holds deployments, which hold the data.
 *
 * :::caution
 * A project defaults to `retain`, so `alchemy destroy` leaves it and its data
 * in place. Pipe it through `RemovalPolicy.destroy()` to remove it.
 * :::
 *
 * ### Creating a Project
 * **Example:** Project with a generated name
 * ```typescript
 * const project = yield* Convex.Project("App");
 * ```
 *
 * **Example:** Named project with tags
 * ```typescript
 * const project = yield* Convex.Project("App", {
 *   name: "my-app",
 *   tags: ["web"],
 * });
 * ```
 *
 * ### Keeping or Removing a Project
 * **Example:** Remove the project on destroy
 * ```typescript
 * const project = yield* Convex.Project("App").pipe(RemovalPolicy.destroy());
 * ```
 *
 * **Example:** Remove it in every stage but prod
 * ```typescript
 * const stack = yield* Stack;
 * const project = yield* Convex.Project("App").pipe(
 *   RemovalPolicy.retain(stack.stage === "prod"),
 * );
 * ```
 *
 * ### Renaming a Project
 * Changing `name` renames the project in place. The slug stays unless you set
 * `slug`, so URLs that use it keep working.
 *
 * **Example:** Rename and set a new slug
 * ```typescript
 * const project = yield* Convex.Project("App", {
 *   name: "My App",
 *   slug: "my-app",
 * });
 * ```
 *
 * ### Adding Deployments
 * **Example:** A project with one preview per stage
 * ```typescript
 * const project = yield* Convex.Project("App");
 * const preview = yield* Convex.Deployment("Preview", { project, type: "preview" });
 * ```
 *
 * ### Adoption and Deletion
 * Convex allows two projects with one name, so a deploy looks for the name
 * first. A project of that name without Alchemy's tag fails with
 * `OwnedBySomeoneElse` unless you deploy with `--adopt`.
 *
 * Deleting a project deletes its deployments and their data, so a project with
 * a prod deployment refuses until that deployment is gone.
 *
 * @see https://docs.convex.dev/management-api
 *
 * @resource
 * @product Projects
 */
export const Project = Resource<Project>("Convex.Project", { defaultRemovalPolicy: "retain" });

const toAttrs = (project: convex.ProjectResponse): ProjectAttributes => ({
  projectId: project.id,
  name: project.name,
  slug: project.slug,
  teamId: project.teamId,
  teamSlug: project.teamSlug,
  tags: [...(project.tags ?? [])],
});

/** Every project in the team with exactly this name, because Convex allows duplicates. */
const findByName = Effect.fn(function* (teamId: number, name: string) {
  const items = yield* Stream.runCollect(convex.listProjects.items({ team_id: teamId, q: name }));
  return Array.from(items).filter((item) => item.name === name);
});

const byId = (projectId: number) =>
  convex
    .getProject({ project_id: projectId })
    .pipe(Effect.catchTag("ProjectNotFound", () => Effect.undefined));

export const ProjectProvider = () =>
  Provider.effect(
    Project,
    Effect.gen(function* () {
      const projectName = (id: string, name: string | undefined) =>
        name
          ? Effect.succeed(name)
          : createPhysicalName({ id, lowercase: true, maxLength: 64, delimiter: "-" });

      const tagFor = (id: string) =>
        Stack.use((stack) => Effect.sync(() => ownershipTag(stack.name, stack.stage, id)));

      return {
        stables: ["projectId", "teamId", "teamSlug"],
        // Name, slug and tags all update through PATCH, so nothing replaces.
        diff: Effect.fn(function* ({ news }) {
          if (!isResolved(news)) return undefined;
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          if (output !== undefined) {
            const project = yield* byId(output.projectId);
            return project && toAttrs(project);
          }
          const name = yield* projectName(id, olds?.name);
          const teamId = yield* team;
          const found = yield* findByName(teamId, name);
          const tag = yield* tagFor(id);
          const ours = found.find((project) => project.tags?.includes(tag));
          if (ours) return toAttrs(ours);
          return found[0] && Unowned(toAttrs(found[0]));
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          // A project takes no required props, so `news` may be undefined.
          const props: ProjectProps = news ?? {};
          const name = yield* projectName(id, props.name ?? output?.name);
          const tag = yield* tagFor(id);
          const tags = [...new Set([...(props.tags ?? []), tag])].toSorted();

          // Observe
          const teamId = yield* team;
          let project =
            output !== undefined
              ? yield* byId(output.projectId)
              : (yield* findByName(teamId, name))[0];

          // A 404 may mean another team's project, and creating here would leave
          // the original behind with a twin beside it.
          if (project === undefined && output !== undefined) {
            yield* assertTeam(output.teamId, `project ${output.name}`);
          }

          // Ensure. A duplicate name makes a second project rather than
          // failing, so the read above is the only guard.
          if (project === undefined) {
            yield* session.note(`Creating project ${name}...`);
            const created = yield* createOnce(
              convex.createProject({ team_id: teamId, projectName: name, tags }),
            );
            project = yield* convex.getProject({ project_id: created.projectId });
          }

          // Sync. `tags` replaces the whole list.
          const patch = {
            ...(project.name !== name ? { name } : {}),
            ...(props.slug !== undefined && props.slug !== project.slug
              ? { slug: props.slug }
              : {}),
            ...(!deepEqual([...(project.tags ?? [])].toSorted(), tags) ? { tags } : {}),
          };
          if (Object.keys(patch).length > 0) {
            yield* session.note(`Updating project ${name}...`);
            yield* convex.updateProject({ project_id: project.id, ...patch });
            project = yield* convex.getProject({ project_id: project.id });
          }
          return toAttrs(project);
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* assertTeam(output.teamId, `project ${output.name}`);
          const prod = yield* convex
            .listDeployments({ project_id: output.projectId, deploymentType: "prod" })
            .pipe(Effect.catchTag("ProjectNotFound", () => Effect.succeed([])));
          if (prod.length > 0) {
            return yield* new ProjectHasProductionDeployment({
              projectId: output.projectId,
              message: `Project ${output.name} still has a prod deployment (${prod[0]!.name}). Delete it first.`,
            });
          }
          yield* convex
            .deleteProject({ project_id: output.projectId })
            .pipe(Effect.catchTag("ProjectNotFound", () => Effect.void));
        }),
        // Only projects carrying an ownership tag, so nuke can't reach the rest of a team.
        list: Effect.fn(function* () {
          const teamId = yield* team;
          const items = yield* Stream.runCollect(convex.listProjects.items({ team_id: teamId }));
          return Array.from(items)
            .filter((project) => project.tags?.some(isOwnershipTag))
            .map(toAttrs);
        }),
      };
    }),
  );
