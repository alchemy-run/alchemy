import { Services } from "@distilled.cloud/forgejo";
import type { Repository as ApiRepository } from "@distilled.cloud/forgejo/repository";
import * as Effect from "effect/Effect";
import { isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import { listAccessibleRepositories } from "./Lists.ts";
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

const observe = (owner: string, name: string) =>
  Services.repository
    .repoGet({ owner, repo: name })
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
    diff: ({ news, olds }) =>
      Effect.succeed(
        isResolved(news) && olds !== undefined && news.owner !== olds.owner
          ? ({ action: "replace" } as const)
          : undefined,
      ),
    list: Effect.fn(function* () {
      // `/user/repos` already returns the full repository representation, so
      // enumeration needs no per-repository follow-up request.
      const repositories = yield* listAccessibleRepositories();
      return repositories.map(toAttributes);
    }),
    read: Effect.fn(function* ({ olds, output }) {
      // Prefer the numeric ID: `olds.name` goes stale the moment a rename's
      // state write fails, and a name lookup would then report the
      // repository as missing and re-create it.
      if (output !== undefined) {
        const byId = yield* observeById(output.repoId);
        return byId === undefined ? undefined : toAttributes(byId);
      }
      const repository = yield* observe(olds.owner, olds.name);
      return repository === undefined ? undefined : toAttributes(repository);
    }),
    reconcile: Effect.fn(function* ({ news, olds, output }) {
      // Observe by the numeric ID when one is known, so a rename survives
      // even if the state write that recorded it did not. Otherwise fall
      // back to the previously-deployed name, which is what lets an
      // existing repository be adopted.
      let observed =
        output === undefined ? undefined : yield* observeById(output.repoId);
      if (observed === undefined) {
        observed = yield* observe(news.owner, olds?.name ?? news.name);
      }

      if (observed === undefined) {
        observed = yield* create(news).pipe(
          // A concurrent create wins the race; adopt what is there.
          Effect.catchTag("Conflict", () =>
            Services.repository.repoGet({ owner: news.owner, repo: news.name }),
          ),
        );
      }

      // Sync settings against what was observed, not against `olds`, and
      // skip the call entirely when the live repository already matches.
      const desired = settingsOf(news);
      const updated = matchesDesired(observed, desired)
        ? observed
        : yield* Services.repository.repoEdit({
            owner: observed.owner.login,
            repo: observed.name,
            ...desired,
          });

      if (news.topics !== undefined) {
        const target = { owner: updated.owner.login, repo: updated.name };
        const live = yield* Services.repository.repoListTopics(target);
        const observedTopics = [...(live.topics ?? [])].sort();
        const desiredTopics = [...news.topics].sort();
        const matches =
          observedTopics.length === desiredTopics.length &&
          observedTopics.every(
            (topic, index) => topic === desiredTopics[index],
          );
        if (!matches) {
          yield* Services.repository.repoUpdateTopics({
            ...target,
            topics: [...news.topics],
          });
        }
      }
      return toAttributes(updated);
    }),
    delete: Effect.fn(function* ({ olds, output }) {
      // Resolve the live name from the numeric ID first. Deleting by a stale
      // `olds.name` 404s, which is swallowed as success — the state row would
      // be dropped while the repository lived on.
      const live =
        output?.repoId === undefined
          ? undefined
          : yield* observeById(output.repoId);
      yield* Services.repository
        .repoDelete({
          owner: live?.owner.login ?? olds.owner,
          repo: live?.name ?? olds.name,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
