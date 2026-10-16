import * as artifacts from "@distilled.cloud/cloudflare/artifacts";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { isResourceOfType, Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";

export const isRepository = (value: unknown): value is Repository =>
  isResourceOfType(value, "Cloudflare.Artifacts.Repository");

/** Seed a new repository from a public HTTPS git remote. */
export type RepositoryImport = {
  /**
   * Full HTTPS git remote URL, e.g. `https://github.com/octocat/Hello-World`.
   */
  url: string;
  /**
   * Branch to import.
   * @default the remote's default branch
   */
  branch?: string;
  /** Shallow-clone depth. */
  depth?: number;
};

/** Seed a new repository as a fork of another repository in the same namespace. */
export type RepositoryFork = {
  /** Name of the source repository (in the same `namespace`). */
  repository: string;
  /**
   * Copy only the source's default branch.
   * @default true
   */
  defaultBranchOnly?: boolean;
};

export type RepositoryProps = {
  /**
   * Artifacts namespace that owns the repository (3–63 lowercase
   * alphanumerics or hyphens). Namespaces are created implicitly by the
   * first repository. Changing it replaces the repository.
   */
  namespace: string;
  /**
   * Repository name (alphanumerics, dots, hyphens, underscores; must start
   * with an alphanumeric). Changing it replaces the repository.
   * @default ${app}-${id}-${stage}-${suffix}
   */
  name?: string;
  /**
   * Repository description. Artifacts has no update API, so changing it
   * replaces the repository. Ignored for `import`ed repositories.
   */
  description?: string;
  /**
   * Default branch name. Changing it replaces the repository. Ignored for
   * `import` and `fork` (they inherit the source's default branch).
   * @default "main"
   */
  defaultBranch?: string;
  /**
   * Create the repository read-only (git pushes are rejected). Changing it
   * replaces the repository.
   * @default false
   */
  readOnly?: boolean;
  /**
   * Seed the repository by importing a public HTTPS git remote. Mutually
   * exclusive with `fork`. Changing it replaces the repository.
   */
  import?: RepositoryImport;
  /**
   * Seed the repository as a fork of another repository in the same
   * namespace. Mutually exclusive with `import`. Changing it replaces the
   * repository.
   */
  fork?: RepositoryFork;
};

export type Repository = Resource<
  "Cloudflare.Artifacts.Repository",
  RepositoryProps,
  {
    /** Unique repository ID assigned by Cloudflare. */
    repositoryId: string;
    /** Repository name. */
    name: string;
    /** Artifacts namespace that owns the repository. */
    namespace: string;
    /** Cloudflare account that owns the repository. */
    accountId: string;
    /**
     * HTTPS git remote URL, e.g.
     * `https://<ACCOUNT_ID>.artifacts.cloudflare.net/git/<namespace>/<name>.git`.
     * Authenticate with a {@link RepositoryToken} (see `gitCredential`).
     */
    remote: string;
    /** Default branch name. */
    defaultBranch: string;
    /** Repository description, if set. */
    description: string | undefined;
    /** Whether the repository is read-only. */
    readOnly: boolean;
    /** Import / fork source (e.g. `github:owner/repo`), if any. */
    source: string | undefined;
    /** ISO 8601 creation timestamp. */
    createdAt: string;
  },
  never,
  Providers
>;

/**
 * A Cloudflare Artifacts repository — a Git-compatible, versioned repository
 * stored on Cloudflare and addressable over standard git-over-HTTPS.
 *
 * Artifacts has no update API, so every prop is create-time: changing any of
 * them replaces the repository (and its git history). Mint git credentials
 * with {@link RepositoryToken}, or bind the namespace to a Worker with
 * `Cloudflare.Artifacts.ReadWriteNamespace` to manage repos at runtime.
 *
 * ### Creating a Repository
 * **Example:** Empty repository
 * ```typescript
 * const repo = yield* Cloudflare.Artifacts.Repository("Docs", {
 *   namespace: "my-app",
 *   description: "Generated docs",
 * });
 * // repo.remote → https://<ACCOUNT_ID>.artifacts.cloudflare.net/git/my-app/<name>.git
 * ```
 *
 * **Example:** Import a public GitHub repository
 * ```typescript
 * const mirror = yield* Cloudflare.Artifacts.Repository("Mirror", {
 *   namespace: "my-app",
 *   import: { url: "https://github.com/octocat/Hello-World", depth: 1 },
 * });
 * ```
 *
 * **Example:** Fork another repository in the same namespace
 * ```typescript
 * const fork = yield* Cloudflare.Artifacts.Repository("Fork", {
 *   namespace: "my-app",
 *   fork: { repository: mirror.name },
 * });
 * ```
 *
 * ### Cloning with a token
 * **Example:** Mint a read token and build a clone URL
 * ```typescript
 * const token = yield* Cloudflare.Artifacts.RepositoryToken("ReadToken", {
 *   repository: repo,
 *   scope: "read",
 *   ttl: 3600,
 * });
 * // later, with resolved values:
 * const { url } = Cloudflare.Artifacts.gitCredential(remote, token);
 * // git clone <url>
 * ```
 *
 * @resource
 * @product Artifacts
 * @category Developer Platform
 */
export const Repository = Resource<Repository>("Cloudflare.Artifacts.Repository");

type Attributes = Repository["Attributes"];

const IN_PROGRESS = ["ArtifactsImportInProgress", "ArtifactsForkInProgress"] as const;

/**
 * Observe a repository, riding out import/fork provisioning (bounded) and
 * mapping a missing repository to `undefined`.
 */
const observeRepository = (accountId: string, namespace: string, name: string) =>
  artifacts.getRepo({ accountId, namespace, name }).pipe(
    Effect.retry({
      while: (e) => (IN_PROGRESS as readonly string[]).includes(e._tag),
      schedule: Schedule.spaced("2 seconds"),
      times: 30,
    }),
    Effect.catchTag("ArtifactsRepositoryNotFound", () => Effect.succeed(undefined)),
  );

const toAttributes = (
  accountId: string,
  namespace: string,
  repo: artifacts.Repo | artifacts.ListedRepo,
): Attributes => ({
  repositoryId: repo.id,
  name: repo.name,
  namespace,
  accountId,
  remote: repo.remote,
  defaultBranch: repo.defaultBranch,
  description: repo.description ?? undefined,
  readOnly: repo.readOnly,
  source: repo.source ?? undefined,
  createdAt: repo.createdAt,
});

const createRepoName = (id: string, name: string | undefined) =>
  name !== undefined
    ? Effect.succeed(name)
    : createPhysicalName({ id, maxLength: 63, lowercase: true });

const sameJson = (a: unknown, b: unknown) =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export const RepositoryProvider = () =>
  Provider.succeed(Repository, {
    stables: ["repositoryId", "name", "namespace", "accountId", "remote", "createdAt"],
    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const { accountId } = yield* yield* CloudflareEnvironment;
      if (output && output.accountId !== accountId) return { action: "replace" } as const;
      const namespace = output?.namespace ?? olds?.namespace;
      if (namespace !== undefined && news.namespace !== namespace) {
        return { action: "replace" } as const;
      }
      // Engine-owned names: only an explicit, different name forces a
      // replacement — never drift in the physical-name generator.
      const name = output?.name ?? olds?.name;
      if (news.name !== undefined && name !== undefined && news.name !== name) {
        return { action: "replace" } as const;
      }
      // Artifacts has no update API: every other prop is create-time. An
      // explicit name survives the replacement, so the old repository must
      // be deleted first to free it; engine-generated names get a fresh
      // instance suffix and can be created before the old one is deleted.
      if (
        olds &&
        ((news.description ?? undefined) !== (olds.description ?? undefined) ||
          (news.defaultBranch ?? undefined) !== (olds.defaultBranch ?? undefined) ||
          (news.readOnly ?? false) !== (olds.readOnly ?? false) ||
          !sameJson(news.import, olds.import) ||
          !sameJson(news.fork, olds.fork))
      ) {
        return { action: "replace", deleteFirst: news.name !== undefined } as const;
      }
    }),
    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { accountId: envAccountId } = yield* yield* CloudflareEnvironment;
      const accountId = output?.accountId ?? envAccountId;
      const namespace = news.namespace;
      const name = news.name ?? output?.name ?? (yield* createRepoName(id, undefined));

      if (news.import && news.fork) {
        return yield* Effect.die(
          new Error(`Artifacts repository '${name}': 'import' and 'fork' are mutually exclusive`),
        );
      }

      // Observe — the live repository is authoritative; `output` is only a
      // cache for its identity.
      let observed = yield* observeRepository(accountId, namespace, name);

      // Ensure — create (or import / fork) when missing. An AlreadyExists
      // race means a concurrent create won; fall through to re-observe.
      if (!observed) {
        if (news.import) {
          yield* artifacts
            .importRepo({
              accountId,
              namespace,
              name,
              url: news.import.url,
              branch: news.import.branch,
              depth: news.import.depth,
              readOnly: news.readOnly,
            })
            .pipe(
              Effect.asVoid,
              Effect.catchTag("ArtifactsRepositoryAlreadyExists", () => Effect.void),
            );
        } else if (news.fork) {
          yield* artifacts
            .forkRepo({
              accountId,
              namespace,
              repo: news.fork.repository,
              name,
              description: news.description,
              readOnly: news.readOnly,
              defaultBranchOnly: news.fork.defaultBranchOnly,
            })
            .pipe(
              Effect.asVoid,
              Effect.catchTag("ArtifactsRepositoryAlreadyExists", () => Effect.void),
            );
        } else {
          yield* artifacts
            .createRepo({
              accountId,
              namespace,
              name,
              description: news.description,
              defaultBranch: news.defaultBranch,
              readOnly: news.readOnly,
            })
            .pipe(
              Effect.asVoid,
              Effect.catchTag("ArtifactsRepositoryAlreadyExists", () => Effect.void),
            );
        }
        observed = yield* observeRepository(accountId, namespace, name);
        if (!observed) {
          return yield* Effect.die(
            new Error(`Artifacts repository '${namespace}/${name}' vanished after create`),
          );
        }
      }

      // Sync — nothing is mutable through the Artifacts API; every prop
      // change is a replacement (see `diff`).
      return toAttributes(accountId, namespace, observed);
    }),
    delete: Effect.fn(function* ({ output }) {
      yield* artifacts
        .deleteRepo({
          accountId: output.accountId,
          namespace: output.namespace,
          name: output.name,
        })
        .pipe(Effect.catchTag("ArtifactsRepositoryNotFound", () => Effect.void));
    }),
    read: Effect.fn(function* ({ id, olds, output }) {
      const { accountId: envAccountId } = yield* yield* CloudflareEnvironment;
      const accountId = output?.accountId ?? envAccountId;
      const namespace = output?.namespace ?? olds?.namespace;
      if (namespace === undefined) return undefined;
      const name = output?.name ?? (yield* createRepoName(id, olds?.name));
      const repo = yield* observeRepository(accountId, namespace, name);
      return repo ? toAttributes(accountId, namespace, repo) : undefined;
    }),
    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      return yield* artifacts.listNamespaces.items({ accountId }).pipe(
        Stream.flatMap((ns) =>
          artifacts.listRepos
            .items({ accountId, namespace: ns.namespace })
            .pipe(Stream.map((repo) => toAttributes(accountId, ns.namespace, repo))),
        ),
        Stream.runCollect,
        Effect.map((chunk) => Array.from(chunk)),
      );
    }),
  });
