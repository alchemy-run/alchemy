import * as Repos from "@distilled.cloud/github/repos";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import {
  github,
  gitHubBaseUrlChanged,
  githubFor,
  listAll,
  listRepositories,
  PER_PAGE,
} from "./Client.ts";
import type * as GitHub from "./Providers.ts";

export interface CollaboratorProps {
  /**
   * Repository owner — a user or organization login.
   */
  owner: string;

  /**
   * Repository name.
   */
  repository: string;

  /**
   * GitHub username to grant access.
   */
  username: string;

  /**
   * Permission level to grant.
   * - `pull` — read-only access
   * - `push` — read and write access
   * - `maintain` — read, write, and manage issues/PRs
   * - `triage` — read and manage issues/PRs without write access
   * - `admin` — full admin access
   *
   * @default "push"
   */
  permission?: "pull" | "push" | "maintain" | "triage" | "admin";

  /**
   * Override the GitHub host or API base URL for this resource only (e.g.
   * `github.example.com` for GitHub Enterprise). Falls back to
   * `GitHub.providers({ baseUrl })`, then to the host resolved by the auth
   * provider. Changing it replaces the resource — the same name on a
   * different GitHub instance is a different physical resource.
   */
  baseUrl?: string;
}

export interface Collaborator extends Resource<
  "GitHub.Collaborator",
  CollaboratorProps,
  {
    /**
     * GitHub username.
     */
    username: string;

    /**
     * Permission level granted.
     */
    permission: string;
  },
  never,
  GitHub.Providers
> {}

/**
 * A GitHub repository collaborator.
 *
 * `Collaborator` grants a user direct access to a repository. For
 * organization-owned repositories, prefer `GitHub.TeamAccess` to grant
 * access through teams instead of individual users.
 *
 * Collaborators default to **retain** on removal — destroying the stack does
 * NOT remove the collaborator, preventing accidental lockout. Opt in to
 * actual removal by wrapping the resource in {@link destroy}() from
 * `alchemy/RemovalPolicy`.
 *
 * Authentication is resolved via the `GitHubCredentials` service supplied by
 * `GitHub.providers()` (env, stored PAT, `gh` CLI, or OAuth). The token needs
 * `repo` scope (and `admin:repo` for removal when opted in via `destroy()`).
 *
 * ### Adding a Collaborator
 * **Example:** Grant Push Access
 * ```typescript
 * yield* GitHub.Collaborator("collaborator", {
 *   owner: "my-org",
 *   repository: "my-repo",
 *   username: "contributor",
 *   permission: "push",
 * })
 * ```
 *
 * **Example:** Grant Admin Access
 * ```typescript
 * yield* GitHub.Collaborator("admin", {
 *   owner: "my-org",
 *   repository: "my-repo",
 *   username: "team-lead",
 *   permission: "admin",
 * })
 * ```
 *
 * **Example:** Grant Read-Only Access
 * ```typescript
 * yield* GitHub.Collaborator("readonly", {
 *   owner: "my-org",
 *   repository: "my-repo",
 *   username: "auditor",
 *   permission: "pull",
 * })
 * ```
 *
 * ### Removing a Collaborator
 * **Example:** Allow Removal on Destroy
 * ```typescript
 * import { destroy } from "alchemy/RemovalPolicy"
 *
 * yield* GitHub.Collaborator("temp", {
 *   owner: "my-org",
 *   repository: "my-repo",
 *   username: "contractor",
 *   permission: "push",
 * }).pipe(destroy())
 * ```
 *
 * @resource
 * @product Repository
 */
export const Collaborator = Resource<Collaborator>("GitHub.Collaborator", {
  defaultRemovalPolicy: "retain",
});

export const CollaboratorProvider = () =>
  Provider.succeed(Collaborator, {
    diff: Effect.fn(function* ({ news, olds }) {
      if (!isResolved(news)) return;
      if (olds === undefined) return;
      if (
        news.owner !== olds.owner ||
        news.repository !== olds.repository ||
        news.username !== olds.username ||
        (yield* gitHubBaseUrlChanged(olds, news))
      ) {
        return { action: "replace" };
      }
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const github = yield* githubFor(news.baseUrl);

      // Ensure & Sync — PUT is idempotent; creates or updates permission
      yield* github(
        Repos.addCollaborator({
          owner: news.owner,
          repo: news.repository,
          username: news.username,
          permission: news.permission ?? "push",
        }),
      );

      return {
        username: news.username,
        permission: news.permission ?? "push",
      };
    }),

    list: Effect.fn(function* () {
      const repos = yield* listRepositories;
      const perRepo = yield* Effect.forEach(
        repos,
        (repo) =>
          listAll((page) =>
            github(
              Repos.listCollaborators({
                owner: repo.owner.login,
                repo: repo.name,
                per_page: PER_PAGE,
                page,
              }),
            ),
          ).pipe(
            Effect.map((collaborators) =>
              collaborators.map((collab) => ({
                username: collab.login,
                permission: collab.permissions?.admin
                  ? ("admin" as const)
                  : collab.permissions?.maintain
                    ? ("maintain" as const)
                    : collab.permissions?.push
                      ? ("push" as const)
                      : collab.permissions?.triage
                        ? ("triage" as const)
                        : ("pull" as const),
              })),
            ),
            Effect.catchTag(["Forbidden", "NotFound"], () => Effect.succeed([])),
          ),
        { concurrency: 10 },
      );
      return perRepo.flat();
    }),

    delete: Effect.fn(function* ({ olds }) {
      const github = yield* githubFor(olds.baseUrl);
      yield* github(
        Repos.removeCollaborator({
          owner: olds.owner,
          repo: olds.repository,
          username: olds.username,
        }),
      ).pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
