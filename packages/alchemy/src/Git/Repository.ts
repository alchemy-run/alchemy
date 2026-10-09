import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as HttpApiClient from "effect/http-api/HttpApiClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../AdoptPolicy.ts";
import { isResolved } from "../Diff.ts";
import { createPhysicalName } from "../PhysicalName.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import { GitApi, type Repo } from "./Api.ts";
import type { Providers } from "./Providers.ts";

/**
 * The HTTP Basic credential presented to a Git host. It is whatever your
 * Git host's auth middleware accepts — e.g. a Better Auth API key as the
 * password, or a shared secret.
 */
export interface RepositoryCredentials {
  /**
   * The Basic-auth username. Most hosts only read the password.
   * @default "git"
   */
  username?: string;
  /**
   * The Basic-auth password (an API key or token).
   */
  password: Redacted.Redacted<string>;
}

/**
 * An external smart-HTTP repository to import from on creation.
 */
export interface RepositoryImport {
  /**
   * Smart-HTTP URL of the source repository (e.g.
   * `https://github.com/octocat/Hello-World.git`).
   */
  url: string;
  /**
   * Restrict the import to a single ref.
   */
  ref?: string;
  /**
   * Depth-limit the imported history.
   */
  depth?: number;
}

export interface RepositoryProps {
  /**
   * Base URL of the deployed Git host — the Worker that serves the
   * `alchemy/Git` routes (e.g. `host.url`). Changing it replaces the
   * repository: the same name on a different host is a different
   * repository.
   */
  url: string;

  /**
   * Owner (namespace) the repository lives under. Changing the owner
   * replaces the repository — a new, empty repository is created and the
   * old one is deleted.
   */
  owner: string;

  /**
   * Repository name: 1–100 chars, alphanumeric with `._-` separators.
   * The service has no rename API, so changing it replaces the repository.
   *
   * @default ${app}-${id}-${stage}-${suffix}
   */
  name?: string;

  /**
   * Human description. Removing it clears the description.
   */
  description?: string;

  /**
   * Default branch short name (HEAD's target). Set at creation; on update
   * it is only applied when the branch already exists.
   * @default "main"
   */
  defaultBranch?: string;

  /**
   * `public` repositories are readable (REST reads, `git clone`/`fetch`)
   * without a credential. Writes always require one.
   * @default "private"
   */
  visibility?: "public" | "private";

  /**
   * Reject pushes and REST ref writes when `true`.
   * @default false
   */
  readOnly?: boolean;

  /**
   * Seed the repository from an external smart-HTTP source. Only used at
   * creation — changing it later has no effect on an existing repository.
   */
  import?: RepositoryImport;

  /**
   * The credential used to manage the repository over the host's REST
   * API. Whatever your Git host's auth middleware accepts; omit it for
   * a host without auth.
   */
  credentials?: RepositoryCredentials;
}

export interface Repository extends Resource<
  "Git.Repository",
  RepositoryProps,
  {
    /**
     * Stable ULID identity of the repository.
     */
    repoId: string;
    /**
     * Base URL of the Git host.
     */
    url: string;
    /**
     * Owner (namespace) segment.
     */
    owner: string;
    /**
     * Repository name segment.
     */
    name: string;
    /**
     * Full name in `owner/name` form.
     */
    fullName: string;
    /**
     * HTTPS clone URL (`${url}/${owner}/${name}.git`).
     */
    cloneUrl: string;
    /**
     * The default branch HEAD points at.
     */
    defaultBranch: string;
    /**
     * Observed visibility.
     */
    visibility: "public" | "private";
    /**
     * Whether pushes are rejected.
     */
    readOnly: boolean;
    /**
     * Observed description.
     */
    description: string | undefined;
    /**
     * Creation time, epoch milliseconds.
     */
    createdAt: number;
  },
  never,
  Providers
> {}

/**
 * A repository on an Alchemy Git host — the `alchemy/Git` service you
 * deploy as a Cloudflare Worker.
 *
 * The repository is created on first deploy over the host's REST API
 * (`POST /api/v1/repos`) and its settings (description, visibility,
 * read-only, default branch) are converged on every later deploy. Who may
 * do that is decided by the host's own auth middleware: pass the HTTP
 * Basic credential it accepts as `credentials`.
 *
 * Register the provider with `Git.providers()` next to the host's cloud
 * providers.
 *
 * ### Creating a Repository
 * **Example:** A Repository on a Deployed Git Host
 * ```typescript
 * const host = yield* GitHost;
 * const repo = yield* Git.Repository("app", {
 *   url: host.url.as<string>(),
 *   owner: "acme",
 *   description: "The app",
 *   credentials: { password: Redacted.make(process.env.GIT_API_KEY!) },
 * });
 * ```
 *
 * **Example:** Registering the Provider
 * ```typescript
 * export default Alchemy.Stack(
 *   "GitApp",
 *   {
 *     providers: Layer.mergeAll(Cloudflare.providers(), Git.providers()),
 *     state: Alchemy.localState(),
 *   },
 *   Effect.gen(function* () {
 *     // ...
 *   }),
 * );
 * ```
 *
 * ### Visibility and Read-Only
 * **Example:** Public, Read-Only Mirror
 * ```typescript
 * yield* Git.Repository("docs", {
 *   url: host.url.as<string>(),
 *   owner: "acme",
 *   name: "docs",
 *   visibility: "public",
 *   readOnly: true,
 *   credentials,
 * });
 * ```
 *
 * ### Importing a Repository
 * **Example:** Seed from GitHub
 * The import runs once, at creation.
 * ```typescript
 * yield* Git.Repository("hello", {
 *   url: host.url.as<string>(),
 *   owner: "acme",
 *   import: { url: "https://github.com/octocat/Hello-World.git" },
 *   credentials,
 * });
 * ```
 *
 * ### Cloning
 * **Example:** Credentials for `git clone`
 * ```typescript
 * const { url, username, password } = Git.cloneCredentials(repo, credentials);
 * // git clone https://<username>:<password>@host/acme/app.git
 * ```
 *
 * @resource
 * @product Repository
 */
export const Repository = Resource<Repository>("Git.Repository");

/** A repository did not reach the expected status within the poll budget. */
export class RepositoryNotReady extends Data.TaggedError("Git.RepositoryNotReady")<{
  readonly owner: string;
  readonly name: string;
  readonly status: string;
}> {}

/**
 * The `git` credentials for a repository: its clone URL plus the HTTP
 * Basic username/password the host accepts.
 *
 * @example
 * ```typescript
 * const { url, username, password } = Git.cloneCredentials(repo, credentials);
 * ```
 */
export const cloneCredentials = (
  repo: { readonly cloneUrl: string },
  credentials: RepositoryCredentials,
): { url: string; username: string; password: Redacted.Redacted<string> } => ({
  url: repo.cloneUrl,
  username: credentials.username ?? DEFAULT_USERNAME,
  password: credentials.password,
});

const DEFAULT_USERNAME = "git";

const trimUrl = (url: string) => url.replace(/\/+$/, "");

const cloneUrlOf = (url: string, owner: string, name: string) =>
  `${trimUrl(url)}/${owner}/${name}.git`;

const attrsOf = (url: string, repo: Repo): Repository["Attributes"] => ({
  repoId: repo.repoId,
  url: trimUrl(url),
  owner: repo.owner,
  name: repo.name,
  fullName: `${repo.owner}/${repo.name}`,
  cloneUrl: cloneUrlOf(url, repo.owner, repo.name),
  defaultBranch: repo.defaultBranch,
  visibility: repo.public ? "public" : "private",
  readOnly: repo.readOnly,
  description: repo.description ?? undefined,
  createdAt: repo.createdAt,
});

/**
 * Unwrap to exactly one `Redacted` layer: a caller may pass an already
 * redacted value wrapped again.
 */
const unwrap = (value: Redacted.Redacted<string> | string): Redacted.Redacted<string> => {
  let inner: unknown = value;
  while (Redacted.isRedacted(inner)) inner = Redacted.value(inner);
  return Redacted.make(String(inner));
};

/**
 * Fresh workers.dev URLs answer 404 for a few seconds and a booting Worker
 * refuses connections; both are transient. Every other HTTP failure is not.
 */
const isTransient = (error: unknown) =>
  error instanceof HttpClientError.HttpClientError &&
  (error.reason._tag === "TransportError" ||
    (error.reason._tag === "StatusCodeError" &&
      (error.reason.response.status === 404 || error.reason.response.status >= 500)));

const retryTransient = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.retry({
      while: isTransient,
      schedule: Schedule.exponential("500 millis"),
      times: 6,
    }),
  );

/** Poll schedule for async repo status (import, purge): ~30s budget. */
const pollSchedule = Schedule.spaced("500 millis");
const POLL_TIMES = 60;

class StillPending extends Data.TaggedError("StillPending")<{ readonly status: string }> {}

export const RepositoryProvider = () =>
  Provider.effect(
    Repository,
    Effect.gen(function* () {
      const http = yield* HttpClient.HttpClient;

      /** The typed `repos` client, derived from the host's own `GitApi` contract. */
      const reposClient = (url: string, credentials: RepositoryCredentials | undefined) =>
        HttpApiClient.group(GitApi, {
          group: "repos",
          baseUrl: trimUrl(url),
          httpClient:
            credentials === undefined
              ? http
              : HttpClient.mapRequest(
                  http,
                  HttpClientRequest.basicAuth(
                    credentials.username ?? DEFAULT_USERNAME,
                    unwrap(credentials.password),
                  ),
                ),
        });

      type ReposClient = Effect.Success<ReturnType<typeof reposClient>>;

      /** The repo, or `undefined` when the name is free. */
      const observe = (client: ReposClient, owner: string, name: string) =>
        retryTransient(client.get({ params: { owner, repo: name } })).pipe(
          Effect.catchTag("RepoNotFound", () => Effect.succeed(undefined)),
        );

      /**
       * Wait until a repo leaves `importing`/`forking` (returns it) or a
       * `deleting` repo's purge frees the name (returns `undefined`).
       */
      const settle = (client: ReposClient, owner: string, name: string) =>
        observe(client, owner, name).pipe(
          Effect.flatMap((repo) =>
            repo === undefined || repo.status === "ready"
              ? Effect.succeed(repo)
              : Effect.fail(new StillPending({ status: repo.status })),
          ),
          Effect.retry({
            while: (e) => e._tag === "StillPending",
            schedule: pollSchedule,
            times: POLL_TIMES,
          }),
          Effect.catchTag("StillPending", (e) =>
            Effect.fail(new RepositoryNotReady({ owner, name, status: e.status })),
          ),
        );

      const physicalName = (id: string, instanceId: string, name: string | undefined) =>
        name !== undefined
          ? Effect.succeed(name)
          : // 96, not the REST limit of 100: the wire routes decode `:repo`
            // WITH its `.git` suffix against the same 100-char grammar.
            createPhysicalName({ id, instanceId, maxLength: 96, lowercase: true });

      return {
        stables: ["repoId", "url", "owner", "name", "fullName", "cloneUrl", "createdAt"],

        // No rename or transfer API: a different host, owner, or explicit
        // name is a different repository. An omitted name keeps the
        // engine-owned name already deployed (never replace on generator drift).
        diff: Effect.fn(function* ({ news, output }) {
          if (!isResolved(news) || output === undefined) return undefined;
          if (
            trimUrl(news.url) !== output.url ||
            news.owner !== output.owner ||
            (news.name !== undefined && news.name !== output.name)
          ) {
            return { action: "replace" as const };
          }
          return undefined;
        }),

        read: Effect.fn(function* ({ id, instanceId, olds, output }) {
          const url = output?.url ?? olds.url;
          const owner = output?.owner ?? olds.owner;
          const name = output?.name ?? (yield* physicalName(id, instanceId, olds.name));
          const client = yield* reposClient(url, olds.credentials);
          const repo = yield* observe(client, owner, name);
          if (repo === undefined || repo.status === "deleting") return undefined;
          const attrs = attrsOf(url, repo);
          // The service carries no ownership markers: a repo is ours when it
          // is the one we created (same repoId), or when its name embeds our
          // instance id (engine-generated). An explicit name we never
          // created is someone else's.
          if (output !== undefined) {
            return output.repoId === repo.repoId ? attrs : Unowned(attrs);
          }
          return olds.name === undefined ? attrs : Unowned(attrs);
        }),

        reconcile: Effect.fn(function* ({ id, instanceId, news, olds, output }) {
          const url = trimUrl(news.url);
          const owner = news.owner;
          const name =
            news.name ?? output?.name ?? (yield* physicalName(id, instanceId, undefined));
          const client = yield* reposClient(url, news.credentials);
          const visibility = news.visibility ?? "private";
          const readOnly = news.readOnly ?? false;

          // Observe — settle async states first: an import in flight
          // finishes, a purge in flight frees the name.
          let repo = yield* settle(client, owner, name);

          // Ensure — create (or import) when missing; a concurrent create
          // is a race, so re-observe.
          if (repo === undefined) {
            if (news.import !== undefined) {
              yield* retryTransient(
                client.import({
                  payload: {
                    owner,
                    name,
                    source: {
                      url: news.import.url,
                      ref: news.import.ref,
                      depth: news.import.depth,
                    },
                  },
                }),
              ).pipe(Effect.catchTag("RepoAlreadyExists", () => Effect.void));
            } else {
              yield* retryTransient(
                client.create({
                  payload: {
                    owner,
                    name,
                    defaultBranch: news.defaultBranch,
                    description: news.description,
                    public: visibility === "public",
                    readOnly,
                  },
                }),
              ).pipe(Effect.catchTag("RepoAlreadyExists", () => Effect.void));
            }
            repo = yield* settle(client, owner, name);
            if (repo === undefined) {
              // Created, then deleted out-of-band before we could observe it.
              return yield* new RepositoryNotReady({ owner, name, status: "missing" });
            }
          }
          const current = repo;

          // Sync — diff observed settings against desired, PATCH the delta.
          // `description` is only managed when set now or previously set.
          const description =
            news.description !== undefined
              ? news.description
              : olds?.description !== undefined
                ? null
                : undefined;
          const patch = {
            description:
              description !== undefined && description !== repo.description
                ? description
                : undefined,
            public: repo.public !== (visibility === "public") ? visibility === "public" : undefined,
            readOnly: repo.readOnly !== readOnly ? readOnly : undefined,
          };
          const defaultBranch =
            news.defaultBranch !== undefined && news.defaultBranch !== repo.defaultBranch
              ? news.defaultBranch
              : undefined;
          const hasSettings =
            patch.description !== undefined ||
            patch.public !== undefined ||
            patch.readOnly !== undefined;

          if (hasSettings || defaultBranch !== undefined) {
            const params = { owner, repo: name };
            repo = yield* retryTransient(
              client.update({ params, payload: { ...patch, defaultBranch } }),
            ).pipe(
              // The default branch must already exist (an empty repo has
              // none yet); converge the other settings without it.
              Effect.catchTag("RefNotFound", () =>
                hasSettings
                  ? retryTransient(client.update({ params, payload: patch }))
                  : Effect.succeed(current),
              ),
            );
          }

          return attrsOf(url, repo);
        }),

        // Async purge: 204 immediately, the name frees once the purge
        // completes. A repo that is already gone is success.
        delete: Effect.fn(function* ({ olds, output }) {
          const client = yield* reposClient(output.url, olds.credentials);
          yield* retryTransient(
            client.delete({ params: { owner: output.owner, repo: output.name } }),
          ).pipe(Effect.catchTag("RepoNotFound", () => Effect.void));
        }),
      };
    }),
  );
