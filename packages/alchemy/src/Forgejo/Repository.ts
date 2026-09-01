import * as Effect from "effect/Effect";
import { isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import { ForgejoCredentials, optional, paginate } from "./Client.ts";
import type * as Forgejo from "./Providers.ts";

/**
 * Desired settings for a Forgejo repository.
 */
export interface RepositoryProps {
  /**
   * User or organization that owns the repository.
   */
  readonly owner: string;
  /**
   * Repository name. Changing it renames the repository in place.
   */
  readonly name: string;
  /**
   * Repository description.
   */
  readonly description?: string;
  /**
   * Repository website URL.
   */
  readonly website?: string;
  /**
   * Whether the repository is private.
   */
  readonly private?: boolean;
  /**
   * Whether issues are enabled.
   */
  readonly hasIssues?: boolean;
  /**
   * Whether projects are enabled.
   */
  readonly hasProjects?: boolean;
  /**
   * Whether the wiki is enabled.
   */
  readonly hasWiki?: boolean;
  /**
   * Whether pull requests are enabled.
   */
  readonly hasPullRequests?: boolean;
  /**
   * Whether releases are enabled.
   */
  readonly hasReleases?: boolean;
  /**
   * Whether packages are enabled.
   */
  readonly hasPackages?: boolean;
  /**
   * Whether Actions are enabled.
   */
  readonly hasActions?: boolean;
  /**
   * Whether the repository is archived.
   */
  readonly archived?: boolean;
  /**
   * Default branch used during initialization and later convergence.
   */
  readonly defaultBranch?: string;
  /**
   * Initialize the repository on creation.
   */
  readonly autoInit?: boolean;
  /**
   * Comma-separated gitignore templates used on creation.
   */
  readonly gitignores?: string;
  /**
   * License template used on creation.
   */
  readonly license?: string;
  /**
   * README template used on creation.
   */
  readonly readme?: string;
  /**
   * Whether the repository is a template.
   */
  readonly template?: boolean;
  /**
   * Git object format used on creation.
   */
  readonly objectFormatName?: "sha1" | "sha256";
  /**
   * Repository topics. This list replaces the live topics.
   */
  readonly topics?: readonly string[];
}

/**
 * Observed attributes of a Forgejo repository.
 */
export interface RepositoryAttributes {
  /**
   * Stable numeric repository identifier.
   */
  readonly repoId: number;
  /**
   * Owner/name repository identifier.
   */
  readonly fullName: string;
  /**
   * Repository web URL.
   */
  readonly htmlUrl: string;
  /**
   * HTTP clone URL.
   */
  readonly cloneUrl: string;
  /**
   * SSH clone URL.
   */
  readonly sshUrl: string;
  /**
   * Current default branch.
   */
  readonly defaultBranch: string;
  /**
   * Creation timestamp.
   */
  readonly createdAt: string;
  /**
   * Last update timestamp.
   */
  readonly updatedAt: string;
}

/**
 * A Forgejo repository resource.
 */
export interface Repository extends Resource<
  "Forgejo.Repository",
  RepositoryProps,
  RepositoryAttributes,
  never,
  Forgejo.Providers
> {}

/**
 * A Forgejo repository.
 *
 * Repositories are retained by default: destroying the stack leaves the
 * repository and its history in place unless removal is opted into
 * explicitly.
 *
 * ### Creating a Repository
 * **Example:** Basic Repository
 * ```typescript
 * const repo = yield* Forgejo.Repository("api", {
 *   owner: "my-org",
 *   name: "api",
 * });
 * ```
 *
 * **Example:** Initialized Private Repository
 * ```typescript
 * yield* Forgejo.Repository("api", {
 *   owner: "my-org",
 *   name: "api",
 *   private: true,
 *   autoInit: true,
 *   license: "Apache-2.0",
 *   defaultBranch: "main",
 * });
 * ```
 *
 * ### Configuring a Repository
 * Topics replace the live list on every deploy, so the declared set is the
 * whole set.
 *
 * **Example:** Features and Topics
 * ```typescript
 * yield* Forgejo.Repository("api", {
 *   owner: "my-org",
 *   name: "api",
 *   description: "Public API service",
 *   hasIssues: true,
 *   hasWiki: false,
 *   hasActions: true,
 *   topics: ["typescript", "effect"],
 * });
 * ```
 *
 * ### Renaming a Repository
 * Changing `name` renames in place and keeps the repository's history and
 * numeric ID. Changing `owner` replaces the resource instead.
 *
 * **Example:** Rename in Place
 * ```typescript
 * yield* Forgejo.Repository("api", {
 *   owner: "my-org",
 *   name: "api-v2",
 * });
 * ```
 *
 * ### Deleting a Repository
 * **Example:** Allow Repository Deletion
 * ```typescript
 * import { destroy } from "alchemy/RemovalPolicy";
 *
 * yield* Forgejo.Repository("preview", {
 *   owner: "my-org",
 *   name: "preview",
 * }).pipe(destroy());
 * ```
 *
 * @resource
 */
export const Repository = Resource<Repository>("Forgejo.Repository", {
  defaultRemovalPolicy: "retain",
});

interface ApiRepository {
  readonly id: number;
  readonly name: string;
  readonly full_name: string;
  readonly html_url: string;
  readonly clone_url: string;
  readonly ssh_url: string;
  readonly default_branch: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly owner: { readonly login: string };
}

interface ApiUser {
  readonly login: string;
}

const pathFor = (owner: string, name: string) =>
  `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;

const observe = Effect.fn(function* (owner: string, name: string) {
  const client = yield* ForgejoCredentials;
  return yield* optional(
    client.request<ApiRepository>("GET", pathFor(owner, name)),
  );
});

const toAttributes = (repository: ApiRepository): RepositoryAttributes => ({
  repoId: repository.id,
  fullName: repository.full_name,
  htmlUrl: repository.html_url,
  cloneUrl: repository.clone_url,
  sshUrl: repository.ssh_url,
  defaultBranch: repository.default_branch,
  createdAt: repository.created_at,
  updatedAt: repository.updated_at,
});

/**
 * Provider layer implementing the Forgejo repository lifecycle.
 */
export const RepositoryProvider = () =>
  Provider.succeed(Repository, {
    stables: ["repoId"],
    diff: ({ news, olds }) =>
      Effect.succeed(
        isResolved(news) && olds !== undefined && news.owner !== olds.owner
          ? ({ action: "replace" } as const)
          : undefined,
      ),
    list: Effect.fn(function* () {
      const client = yield* ForgejoCredentials;
      // `/user/repos` already returns the full repository representation, so
      // enumeration needs no per-repository follow-up request.
      const repositories = yield* paginate<ApiRepository>(
        client,
        "/user/repos",
      );
      return repositories.map(toAttributes);
    }),
    read: Effect.fn(function* ({ olds }) {
      const repository = yield* observe(olds.owner, olds.name);
      return repository === undefined ? undefined : toAttributes(repository);
    }),
    reconcile: Effect.fn(function* ({ news, olds }) {
      const client = yield* ForgejoCredentials;
      // Observe under the previously-deployed name so an in-place rename is
      // seen as the same repository rather than a missing one.
      let observed = yield* observe(news.owner, olds?.name ?? news.name);

      if (observed === undefined) {
        const current = yield* client.request<ApiUser>("GET", "/user");
        const createPath =
          current.login.toLowerCase() === news.owner.toLowerCase()
            ? "/user/repos"
            : `/orgs/${encodeURIComponent(news.owner)}/repos`;
        observed = yield* client
          .request<ApiRepository>("POST", createPath, {
            body: {
              name: news.name,
              description: news.description,
              private: news.private,
              auto_init: news.autoInit,
              default_branch: news.defaultBranch,
              gitignores: news.gitignores,
              license: news.license,
              readme: news.readme,
              template: news.template,
              object_format_name: news.objectFormatName,
            },
          })
          .pipe(
            // A concurrent create wins the race; adopt what is there.
            Effect.catchTag("ForgejoConflict", () =>
              client.request<ApiRepository>(
                "GET",
                pathFor(news.owner, news.name),
              ),
            ),
          );
      }

      const updated = yield* client.request<ApiRepository>(
        "PATCH",
        pathFor(news.owner, observed.name),
        {
          body: {
            name: news.name,
            description: news.description,
            website: news.website,
            private: news.private,
            has_issues: news.hasIssues,
            has_projects: news.hasProjects,
            has_wiki: news.hasWiki,
            has_pull_requests: news.hasPullRequests,
            has_releases: news.hasReleases,
            has_packages: news.hasPackages,
            has_actions: news.hasActions,
            archived: news.archived,
            default_branch: news.defaultBranch,
            template: news.template,
          },
        },
      );

      if (news.topics !== undefined) {
        yield* client.request<void>(
          "PUT",
          `${pathFor(news.owner, news.name)}/topics`,
          {
            body: { topics: [...news.topics] },
          },
        );
      }
      return toAttributes(updated);
    }),
    delete: Effect.fn(function* ({ olds }) {
      const client = yield* ForgejoCredentials;
      yield* optional(
        client.request<void>("DELETE", pathFor(olds.owner, olds.name)),
      );
    }),
  });
