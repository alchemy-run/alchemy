import * as Entire from "@distilled.cloud/entire";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { makeClient, awaitVisible, slugName, waitUntilGone } from "./internal/Client.ts";
import type { Providers } from "./Providers.ts";

export type ProjectProps = {
  /**
   * Project name, unique among the owner's projects: at most 32 lowercase
   * letters, digits, `.` and `-`. It is the project's public address
   * (`et/<name>`) and cannot be renamed — changing it replaces the project.
   * @default a unique name generated from the stack, stage and logical ID
   */
  name?: string;
  /**
   * ID of the org that owns the project. Omit it to create the project in
   * the deploying account. Changing it replaces the project.
   */
  orgId?: string;
  /**
   * Jurisdiction that stores the project's data (`us`, `eu`, `uk`, `au`,
   * `br`, `in`, `sg`). Changing it replaces the project.
   * @default the owner's home jurisdiction
   */
  region?: string;
};

export type Project = Resource<
  "Entire.Project",
  ProjectProps,
  {
    /** Project ID (ULID). */
    id: string;
    /** Project name. */
    name: string;
    /**
     * Host segment of the project's public address. Entire-native projects
     * are `et`; projects mirrored from GitHub are `gh`.
     */
    host: string;
    /** `org` or `account`. */
    ownerType: string;
    /** ID of the owning org or account. */
    ownerId: string;
    /** Jurisdiction that stores the project's data. */
    region: string;
    /** Base URL of the cell that processes the project (its trails, agents and environments). */
    apiUrl: string | undefined;
    /** When the project was created. */
    createdAt: string;
  },
  never,
  Providers
>;

/**
 * An Entire project: the container for repositories, agents, environments
 * and access grants. A project belongs to an org or to a single account and
 * is processed by one regional cell.
 *
 * Entire has no labels, so Alchemy recognises its projects by the ID it
 * stored; a project found only by name is reported as unowned and needs
 * `--adopt`. `alchemy nuke` does not list projects for the same reason.
 *
 * ### Creating a Project
 * **Example:** A project in the deploying account
 * ```typescript
 * const project = yield* Entire.Project("app", {});
 * ```
 *
 * **Example:** A project owned by an org
 * ```typescript
 * const org = yield* Entire.Org("acme", { name: "acme" });
 * const project = yield* Entire.Project("app", {
 *   name: "acme-app",
 *   orgId: org.id,
 * });
 * ```
 *
 * ### Adding Repositories
 * **Example:** A project with a repository
 * ```typescript
 * const project = yield* Entire.Project("app", {});
 * const repo = yield* Entire.Repo("api", { projectId: project.id });
 * ```
 *
 * @resource
 * @product Project
 */
export const Project = Resource<Project>("Entire.Project");

const NATIVE_HOST = "et";

const toAttrs = (p: Entire.projects.Project | Entire.projects.CreatedProject) => ({
  id: p.id,
  name: p.name,
  host: NATIVE_HOST,
  ownerType: p.ownerType,
  ownerId: p.ownerId,
  region: p.region,
  apiUrl: p.apiUrl || undefined,
  createdAt: p.createdAt,
});

export const ProjectProvider = () =>
  Provider.effect(
    Project,
    Effect.gen(function* () {
      const client = yield* makeClient;

      const projectName = (id: string, props: ProjectProps) =>
        props.name ? Effect.succeed(props.name) : slugName(id, 32);

      const get = (projectId: string) => client.core(Entire.projects.getProject({ projectId }));

      /** The caller's project with `name`, owned by `orgId` or by the caller's account. */
      const findByName = (name: string, orgId: string | undefined) =>
        client.core(
          Entire.projects.listProjects.items({}).pipe(
            Stream.filter(
              (p) =>
                p.name === name &&
                (orgId ? p.ownerType === "org" && p.ownerId === orgId : p.ownerType === "account"),
            ),
            Stream.runHead,
            Effect.map(Option.getOrUndefined),
          ),
        );

      return {
        stables: ["id", "host", "ownerType", "ownerId", "region", "createdAt"],
        // Entire projects carry no labels, so nothing distinguishes the ones
        // Alchemy created; listing every project would let nuke delete the
        // user's own.
        list: () => Effect.succeed([]),
        diff: Effect.fn(function* ({ id, olds, news, output }) {
          if (!isResolved(news)) return undefined;
          const name = yield* projectName(id, news);
          if (output && name !== output.name) return { action: "replace" } as const;
          if ((news.orgId ?? undefined) !== (olds?.orgId ?? undefined)) {
            return { action: "replace" } as const;
          }
          if (news.region && output && news.region !== output.region) {
            return { action: "replace" } as const;
          }
          return undefined;
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          if (output?.id) {
            const project = yield* get(output.id).pipe(
              Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
            );
            return project ? toAttrs(project) : undefined;
          }
          // State lost: look the project up by the name it would have. A
          // match cannot be proven ours, so it is offered for adoption.
          const name = yield* projectName(id, olds ?? {});
          const found = yield* findByName(name, olds?.orgId);
          return found ? Unowned(toAttrs(found)) : undefined;
        }),
        reconcile: Effect.fn(function* ({ id, news, output }) {
          const name = yield* projectName(id, news);

          // Observe -- the cached ID first, then the name (adoption).
          const observed = output?.id
            ? yield* get(output.id).pipe(
                Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
              )
            : yield* findByName(name, news.orgId);
          if (observed) return toAttrs(observed);

          // Ensure -- projects have no mutable settings beyond identity.
          const owner = news.orgId
            ? { ownerType: "org" as const, ownerId: news.orgId }
            : {
                ownerType: "account" as const,
                ownerId: (yield* client.core(Entire.identity.getMe({}))).global.accountId,
              };
          const created = yield* client
            .core(Entire.projects.createProject({ name, region: news.region, ...owner }))
            .pipe(
              Effect.catchTag("ProjectNameInUse", () =>
                awaitVisible(findByName(name, news.orgId), `project ${name}`),
              ),
            );
          return toAttrs(created);
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* client
            .core(Entire.projects.deleteProject({ projectId: output.id }))
            .pipe(Effect.catchTag("NotFound", () => Effect.void));
          yield* waitUntilGone(
            client.core(Entire.projects.getProject({ projectId: output.id })),
            `project ${output.name}`,
          );
        }),
      };
    }),
  );
