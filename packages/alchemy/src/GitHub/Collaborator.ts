import * as Repos from "@distilled.cloud/github/repos";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import { gitHubBaseUrlChanged, githubFor } from "./Client.ts";
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
      yield* Repos.addCollaborator({
        owner: news.owner,
        repo: news.repository,
        username: news.username,
        permission: news.permission ?? "push",
      }).pipe(github);

      return {
        username: news.username,
        permission: news.permission ?? "push",
      };
    }),

    list: Effect.fn(function* () {
      const github = yield* githubFor();

      const repos = yield* Repos.listForAuthenticatedUser
        .items({ per_page: 100 })
        .pipe(Stream.runCollect, github);

      // Listing collaborators requires push access; the token can see repos
      // (via org membership) where it has none, so filter on the observed
      // permissions instead of tolerating a 403 per repo.
      const writable = repos.filter((repo) => repo.permissions?.push === true);

      const perRepo = yield* Effect.forEach(
        writable,
        (repo) =>
          Repos.listCollaborators
            .items({
              owner: repo.owner.login,
              repo: repo.name,
              per_page: 100,
            })
            .pipe(
              Stream.runCollect,
              github,
              Effect.map((collaborators) =>
                collaborators.map((collab) => ({
                  username: collab.login,
                  permission: collab.permissions?.admin
                    ? "admin"
                    : collab.permissions?.maintain
                      ? "maintain"
                      : collab.permissions?.push
                        ? "push"
                        : collab.permissions?.triage
                          ? "triage"
                          : "pull",
                })),
              ),
              // Repos where the token lacks access are skipped rather than
              // failing the whole enumeration.
              Effect.catchTag("NotFound", () => Effect.succeed([])),
            ),
        { concurrency: 10 },
      );

      return perRepo.flat();
    }),

    delete: Effect.fn(function* ({ olds }) {
      const github = yield* githubFor(olds.baseUrl);

      // Observe-before-delete: removeCollaborator has no typed NotFound, and
      // the grant (or the whole repository) may already be gone out-of-band.
      // A 404 from the membership probe means there is nothing to remove.
      const existing = yield* Repos.checkCollaborator({
        owner: olds.owner,
        repo: olds.repository,
        username: olds.username,
      }).pipe(
        github,
        Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
      );
      if (existing === undefined) return;

      yield* Repos.removeCollaborator({
        owner: olds.owner,
        repo: olds.repository,
        username: olds.username,
      }).pipe(github);
    }),
  });
