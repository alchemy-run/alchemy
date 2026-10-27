import * as Entire from "@distilled.cloud/entire";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import {
  consistencySchedule,
  makeClient,
  awaitVisible,
  retryCellNotFound,
  retryPropagation,
  slugName,
  waitUntilGone,
} from "./internal/Client.ts";
import type { Providers } from "./Providers.ts";

export type RepoVisibility = "public" | "private";

export type RepoProps = {
  /** ID of the project the repository belongs to. Changing it replaces the repository. */
  projectId: string;
  /**
   * Repository name, unique in the project: 1–64 lowercase letters,
   * digits, `.` and `-`. Its address is `et/<project>/<name>`. Changing it
   * replaces the repository.
   * @default a unique name generated from the stack, stage and logical ID
   */
  name?: string;
  /**
   * Who can read the repository.
   * @default "private"
   */
  visibility?: RepoVisibility;
  /**
   * Git object hash format. Changing it replaces the repository.
   * @default "sha1"
   */
  objectFormat?: "sha1" | "sha256";
  /**
   * Public host of the cluster to pin the repository to (for example
   * `aws-us-east-2.entire.io`). It must be in the project's processing
   * cell. Changing it replaces the repository.
   * @default the cell's cluster
   */
  clusterHost?: string;
};

export type Repo = Resource<
  "Entire.Repo",
  RepoProps,
  {
    /** Repository ID (ULID) — the ID every Core and cell repo route takes. */
    id: string;
    /** Public repository ID (`repo_<ULID>`), stable across placements. */
    repositoryId: string | undefined;
    /** Repository name. */
    name: string;
    /** ID of the owning project. */
    projectId: string;
    /** Address path, `/et/<project>/<name>`. */
    path: string | undefined;
    /** Host of the cluster that serves the repository. */
    clusterHost: string | undefined;
    /** Base URL of the cell that holds the repository's trails, sessions and settings. */
    apiUrl: string | undefined;
    /** Who can read the repository. */
    visibility: RepoVisibility;
    /** Git object hash format. */
    objectFormat: string;
  },
  never,
  Providers
>;

/**
 * A Git repository hosted on Entire, inside a {@link Project}. Agents push
 * to it, and Entire records their sessions, checkpoints and trails against
 * it.
 *
 * `reconcile` returns once the repository is `active` and has reached its
 * cell. Delete waits until Core stops returning it.
 *
 * ### Creating a Repository
 * **Example:** A private repository
 * ```typescript
 * const project = yield* Entire.Project("app", {});
 * const repo = yield* Entire.Repo("api", {
 *   projectId: project.id,
 *   name: "api",
 * });
 * ```
 *
 * **Example:** A public repository
 * ```typescript
 * const docs = yield* Entire.Repo("docs", {
 *   projectId: project.id,
 *   visibility: "public",
 * });
 * ```
 *
 * ### Protecting Branches
 * **Example:** Only server-side merges may update the default branch
 * ```typescript
 * yield* Entire.BranchProtection("api-protection", {
 *   repoId: repo.id,
 *   rules: [{ ref: "HEAD", serverSideMergeOnly: true }],
 * });
 * ```
 *
 * @resource
 * @product Repo
 */
export const Repo = Resource<Repo>("Entire.Repo");

/** The repository is still provisioning after the consistency budget. */
export class RepoNotActive extends Data.TaggedError("RepoNotActive")<{
  readonly repoId: string;
  readonly state: string;
}> {}

const toAttrs = (repo: Entire.repos.Repo | Entire.repos.CreatedRepo) => ({
  id: repo.id,
  repositoryId: typeof repo.repositoryId === "string" ? repo.repositoryId : undefined,
  name: repo.name,
  projectId: repo.owningProjectId,
  path: repo.path,
  clusterHost: repo.clusterHost,
  apiUrl:
    ("placements" in repo
      ? repo.placements?.find((p) => p.id === repo.id)?.apiBaseUrl
      : undefined) ?? undefined,
  visibility: (repo.visibility ?? "private") as RepoVisibility,
  objectFormat: repo.objectFormat ?? "sha1",
});

export const RepoProvider = () =>
  Provider.effect(
    Repo,
    Effect.gen(function* () {
      const client = yield* makeClient;

      const repoName = (id: string, props: { name?: string }) =>
        props.name ? Effect.succeed(props.name) : slugName(id, 64);

      const get = (repoId: string) => client.core(Entire.repos.getRepo({ repoId }));

      const findByName = (projectId: string, name: string) =>
        client.core(
          Entire.repos.listProjectRepos.items({ projectId }).pipe(
            Stream.filter((repo) => repo.name === name),
            Stream.runHead,
            Effect.map(Option.getOrUndefined),
          ),
        );

      /** Poll until the repository leaves provisioning. */
      const waitActive = (repoId: string) =>
        get(repoId).pipe(
          Effect.flatMap((repo) =>
            repo.state === undefined || repo.state === "active"
              ? Effect.succeed(repo)
              : Effect.fail(new RepoNotActive({ repoId, state: repo.state })),
          ),
          Effect.retry({
            while: (e) => e._tag === "RepoNotActive",
            schedule: consistencySchedule,
            times: 30,
          }),
        );

      return {
        stables: ["id", "repositoryId", "projectId", "objectFormat"],
        // Repositories carry no labels; see Project.
        list: () => Effect.succeed([]),
        diff: Effect.fn(function* ({ id, news, output }) {
          if (!isResolved(news) || !output) return undefined;
          if (news.projectId !== output.projectId) return { action: "replace" } as const;
          if ((yield* repoName(id, news)) !== output.name) return { action: "replace" } as const;
          if ((news.objectFormat ?? "sha1") !== output.objectFormat) {
            return { action: "replace" } as const;
          }
          if (news.clusterHost && news.clusterHost !== output.clusterHost) {
            return { action: "replace" } as const;
          }
          return undefined;
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          if (output?.id) {
            const repo = yield* get(output.id).pipe(
              Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
            );
            return repo ? toAttrs(repo) : undefined;
          }
          if (!olds?.projectId) return undefined;
          const found = yield* findByName(olds.projectId, yield* repoName(id, olds));
          return found ? Unowned(toAttrs(found)) : undefined;
        }),
        reconcile: Effect.fn(function* ({ id, news, output }) {
          const name = yield* repoName(id, news);

          // Observe
          let repo: Entire.repos.Repo | undefined = output?.id
            ? yield* get(output.id).pipe(
                Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
              )
            : yield* findByName(news.projectId, name);

          // Ensure
          if (repo === undefined) {
            const created = yield* client
              .core(
                Entire.repos.createRepo({
                  projectId: news.projectId,
                  name,
                  objectFormat: news.objectFormat,
                  clusterHost: news.clusterHost,
                }),
              )
              .pipe(
                retryCellNotFound,
                retryPropagation,
                Effect.catchTag("RepoNameInUse", () =>
                  awaitVisible(findByName(news.projectId, name), `repository ${name}`),
                ),
              );
            repo = yield* waitActive(created.id);
          } else if (repo.state !== undefined && repo.state !== "active") {
            repo = yield* waitActive(repo.id);
          }

          // Ready -- block until the repository has reached its cell, where
          // its trails, settings and agents are addressed.
          const apiUrl = repo.placements?.find((p) => p.id === repo!.id)?.apiBaseUrl;
          yield* client.cell(apiUrl)(
            retryCellNotFound(Entire.repoDetails.getRepoMeta({ repo_id: repo.id })),
          );

          // Sync visibility against the observed value.
          const visibility = news.visibility ?? "private";
          if ((repo.visibility ?? "private") !== visibility) {
            yield* client.core(Entire.repos.setRepoVisibility({ repoId: repo.id, visibility }));
            repo = { ...repo, visibility };
          }
          return toAttrs(repo);
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* client
            .core(Entire.repos.deleteRepo({ repoId: output.id }))
            .pipe(Effect.catchTag("NotFound", () => Effect.void));
          yield* waitUntilGone(get(output.id), `repository ${output.name}`);
        }),
      };
    }),
  );
