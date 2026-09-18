import { Services } from "@distilled.cloud/forgejo";
import type { Repository as ApiRepository } from "@distilled.cloud/forgejo/repository";
import * as Effect from "effect/Effect";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import { listAccessibleRepositories } from "./Lists.ts";
import { isResolved } from "../Diff.ts";
import { Credentials } from "./Credentials.ts";
import { discovered, requireOwnership } from "./Ownership.ts";
import { matchesDesired } from "./Settings.ts";
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
   *
   * Create-only: Forgejo's edit endpoint cannot change it, so altering this
   * on an existing repository has no effect and does not replace it.
   */
  readonly autoInit?: boolean;
  /**
   * Comma-separated gitignore templates used on creation.
   *
   * Create-only; see {@link autoInit}.
   */
  readonly gitignores?: string;
  /**
   * License template used on creation.
   *
   * Create-only; see {@link autoInit}.
   */
  readonly license?: string;
  /**
   * README template used on creation.
   *
   * Create-only; see {@link autoInit}.
   */
  readonly readme?: string;
  /**
   * Whether the repository is a template.
   */
  readonly template?: boolean;
  /**
   * Git object format used on creation.
   *
   * Create-only; see {@link autoInit}.
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
  /** Current owner login, as returned by Forgejo. */
  readonly owner: string;
  /** Current repository name. */
  readonly name: string;
  /** API v1 endpoint of the hosting Forgejo instance. */
  readonly apiBaseUrl: string;
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
 * Declared topics replace the live list during reconciliation, so the
 * declared set is the whole set.
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
 * numeric ID. An out-of-band transfer followed by changing `owner` updates
 * the same numeric repository ID; a different physical repository is replaced.
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

const observe = (owner: string, name: string) =>
  Services.repository
    .getRepo({ owner, repo: name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

/**
 * Look the repository up by its stable numeric ID.
 *
 * A rename whose state persistence failed leaves the previously-deployed name
 * stale, so any lookup keyed on that name reports the repository as missing —
 * which would silently re-create it on reconcile and leak it on delete. The
 * numeric ID survives renames, so it is the identifier to prefer whenever one
 * is known.
 */
const observeById = (repoId: number) =>
  Services.repository
    .repoGetByID({ id: repoId })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

/**
 * Settings the edit endpoint manages. An omitted prop is left alone rather
 * than reset, so `undefined` entries are dropped from the comparison too.
 */
const settingsOf = (props: RepositoryProps) => ({
  name: props.name,
  description: props.description,
  website: props.website,
  private: props.private,
  has_issues: props.hasIssues,
  has_projects: props.hasProjects,
  has_wiki: props.hasWiki,
  has_pull_requests: props.hasPullRequests,
  has_releases: props.hasReleases,
  has_packages: props.hasPackages,
  has_actions: props.hasActions,
  archived: props.archived,
  default_branch: props.defaultBranch,
  template: props.template,
});

const attributesOf = (
  repository: ApiRepository,
  apiBaseUrl: string,
): RepositoryAttributes => ({
  owner: repository.owner.login,
  name: repository.name,
  apiBaseUrl,
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
 * Create the repository under a user or an organization.
 *
 * Forgejo has one create endpoint per owner kind, and only the authenticated
 * user may own a repository created through the user endpoint — every other
 * owner has to be an organization.
 */
const create = Effect.fn(function* (news: RepositoryProps) {
  const options = {
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
  };
  const current = yield* Services.user.userGetCurrent({});
  return current.login.toLowerCase() === news.owner.toLowerCase()
    ? yield* Services.repository.createCurrentUserRepo(options)
    : yield* Services.organization.createOrgRepo({
        org: news.owner,
        ...options,
      });
});

/**
 * Provider layer implementing the Forgejo repository lifecycle.
 */
export const RepositoryProvider = () =>
  Provider.succeed(Repository, {
    stables: ["repoId"],
    diff: Effect.fn(function* ({ news, olds, output }) {
      if (
        isResolved(news) &&
        olds !== undefined &&
        news.owner.toLowerCase() !== olds.owner.toLowerCase()
      ) {
        const target = yield* observe(news.owner, news.name);
        if (output === undefined || target?.id !== output.repoId)
          return { action: "replace" as const };
      }
      if (
        output !== undefined &&
        (!output.owner || !output.name || !output.apiBaseUrl)
      )
        return { action: "update" as const };
    }),
    list: Effect.fn(function* () {
      // `/user/repos` already returns the full repository representation, so
      // enumeration needs no per-repository follow-up request.
      const repositories = yield* listAccessibleRepositories();
      const { apiBaseUrl } = yield* yield* Credentials;
      return repositories.map((repo) => attributesOf(repo, apiBaseUrl));
    }),
    read: Effect.fn(function* ({ olds, output }) {
      // Prefer the numeric ID: `olds.name` goes stale the moment a rename's
      // state write fails, and a name lookup would then report the
      // repository as missing and re-create it.
      const observed =
        output === undefined
          ? yield* observe(olds.owner, olds.name)
          : yield* observeById(output.repoId);
      const { apiBaseUrl } = yield* yield* Credentials;
      return observed === undefined
        ? undefined
        : discovered(attributesOf(observed, apiBaseUrl), output !== undefined);
    }),
    reconcile: Effect.fn(function* ({ news, output }) {
      const { apiBaseUrl } = yield* yield* Credentials;
      let observed =
        output === undefined
          ? yield* observe(news.owner, news.name)
          : yield* observeById(output.repoId);
      if (observed !== undefined) {
        yield* requireOwnership(
          output?.repoId === observed.id,
          observed.full_name,
        );
      } else {
        observed = yield* create(news).pipe(
          Effect.catchTag("Conflict", () =>
            Effect.gen(function* () {
              const existing = yield* Services.repository.getRepo({
                owner: news.owner,
                repo: news.name,
              });
              yield* requireOwnership(
                output?.repoId === existing.id,
                existing.full_name,
              );
              return existing;
            }),
          ),
        );
      }

      // Sync settings against what was observed, not against `olds`, and
      // skip the call entirely when the live repository already matches.
      const desired = settingsOf(news);
      const updated = matchesDesired(observed, desired)
        ? observed
        : yield* Services.repository.editRepo({
            owner: observed.owner.login,
            repo: observed.name,
            ...desired,
          });

      // Topics live behind their own endpoint, so they are synced the same
      // way but separately: observe the live list, replace it only when the
      // declared set differs.
      //
      // The guard is what leaves an omitted `topics` unmanaged — it must stay
      // outside the comparison. `matchesDesired` treats an `undefined` desired
      // value as "unmanaged" too, but only per key, and reaching it would mean
      // having already paid for the live read.
      if (news.topics !== undefined) {
        const target = { owner: updated.owner.login, repo: updated.name };
        const live = yield* Services.repository.repoListTopics(target);
        const topics = [...news.topics];
        if (!matchesDesired({ topics: live.topics ?? [] }, { topics })) {
          yield* Services.repository.repoUpdateTopics({ ...target, topics });
        }
      }
      return attributesOf(updated, apiBaseUrl);
    }),
    delete: Effect.fn(function* ({ output }) {
      // Resolve the live name from the numeric ID first. Deleting by a stale
      // `olds.name` 404s, which is swallowed as success — the state row would
      // be dropped while the repository lived on.
      const live = yield* observeById(output.repoId);
      if (live === undefined) return;
      yield* Services.repository
        .deleteRepo({
          owner: live.owner.login,
          repo: live.name,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
