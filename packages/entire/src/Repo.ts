import * as Entire from "@distilled.cloud/entire";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Redacted from "effect/Redacted";
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
  /**
   * Branch protection rules, one per ref pattern, each ref at most once.
   * The repository has one rule set, so these replace any rules set
   * elsewhere; `[]` clears them.
   * @default unmanaged — existing rules are left as they are
   */
  branchProtection?: BranchProtectionRule[];
  /**
   * Whether Entire records trails for the repository.
   * @default unmanaged — the current value is kept
   */
  trailsEnabled?: boolean;
  /**
   * Whether agent runners may run for the repository.
   * @default unmanaged — the current value is kept
   */
  runnersEnabled?: boolean;
  /**
   * Whether runners start automatically on push. Requires `runnersEnabled`.
   * @default unmanaged — the current value is kept
   */
  autoRunOnPush?: boolean;
  /**
   * Whether sessions of the repository may be shared by public link.
   * @default unmanaged — the current value is kept
   */
  publicSharingEnabled?: boolean;
  /**
   * Model-provider API keys Entire's agent runners use, by key. Entire
   * stores only `api_key_anthropic` and `api_key_openai`. Values are
   * write-only: Entire never returns them, so every deploy writes them
   * again. Keys left out are removed.
   * @default unmanaged — existing keys are left as they are
   */
  secrets?: Partial<Record<RepoSecretKey, Redacted.Redacted<string>>>;
};

/** The model-provider keys Entire's runners read from a repository. */
export type RepoSecretKey = "api_key_anthropic" | "api_key_openai";

export interface BranchProtectionRule {
  /** `HEAD` (the default branch) or a `refs/heads/` name; fnmatch wildcards are allowed. */
  ref: string;
  /**
   * `true` lets the branch move only through a server-side merge by Entire,
   * refusing every direct push (fast-forwards included). `false` protects
   * it from force-pushes and deletion.
   * @default false
   */
  serverSideMergeOnly?: boolean;
}

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
    /** The branch protection rules Entire stored, in order. */
    branchProtection: { ref: string; serverSideMergeOnly: boolean }[];
    trailsEnabled: boolean;
    runnersEnabled: boolean;
    autoRunOnPush: boolean;
    publicSharingEnabled: boolean;
    /** Secret keys that are set (values are never returned). */
    secretKeys: RepoSecretKey[];
  },
  never,
  Providers
>;

/**
 * A Git repository hosted on Entire, inside a {@link Project}. Agents push
 * to it, and Entire records their sessions, checkpoints and trails against
 * it.
 *
 * Branch protection, the trail and runner settings, and the model-provider
 * keys are props of the repository. Each one you leave out is unmanaged:
 * its current value is kept and reported in the attributes.
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
 * const repo = yield* Entire.Repo("api", {
 *   projectId: project.id,
 *   branchProtection: [
 *     { ref: "HEAD", serverSideMergeOnly: true },
 *     { ref: "refs/heads/release/*" },
 *   ],
 * });
 * ```
 *
 * ### Running Agents
 * **Example:** Run agents on every push, with an Anthropic key
 * ```typescript
 * const repo = yield* Entire.Repo("api", {
 *   projectId: project.id,
 *   runnersEnabled: true,
 *   autoRunOnPush: true,
 *   secrets: {
 *     api_key_anthropic: yield* Config.redacted("ANTHROPIC_API_KEY"),
 *   },
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

const coreAttrs = (repo: Entire.repos.Repo) => ({
  id: repo.id,
  repositoryId: typeof repo.repositoryId === "string" ? repo.repositoryId : undefined,
  name: repo.name,
  projectId: repo.owningProjectId,
  path: repo.path,
  clusterHost: repo.clusterHost,
  apiUrl: cellUrl(repo),
  visibility: (repo.visibility ?? "private") as RepoVisibility,
  objectFormat: repo.objectFormat ?? "sha1",
});

/** Base URL of the repository's own placement's cell. */
const cellUrl = (repo: Entire.repos.Repo) =>
  repo.placements?.find((p) => p.id === repo.id)?.apiBaseUrl;

const normalizeRules = (rules: ReadonlyArray<{ ref: string; serverSideMergeOnly?: boolean }>) =>
  rules.map((r) => ({ ref: r.ref, serverSideMergeOnly: r.serverSideMergeOnly ?? false }));

const isSecretKey = (key: string): key is RepoSecretKey =>
  key === "api_key_anthropic" || key === "api_key_openai";

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

      /**
       * Everything Entire stores on the repository besides its identity:
       * branch rules from Core, settings and secret keys from its cell.
       */
      const observe = Effect.fn(function* (repo: Entire.repos.Repo) {
        const cell = client.cell(cellUrl(repo));
        const meta = yield* cell(
          retryCellNotFound(Entire.repoDetails.getRepoMeta({ repo_id: repo.id })),
        );
        const protection = yield* client.core(
          Entire.repos.getBranchProtection({ repoId: repo.id }),
        );
        const secrets = yield* cell(
          retryCellNotFound(Entire.repoSettings.listRepoSecrets({ repo_id: repo.id })),
        );
        return {
          ...coreAttrs(repo),
          branchProtection: normalizeRules(protection.rules),
          trailsEnabled: meta.trails_enabled,
          runnersEnabled: meta.runners_enabled,
          autoRunOnPush: meta.auto_run_on_push,
          publicSharingEnabled: meta.public_sharing_enabled,
          secretKeys: (secrets.items ?? []).map((i) => i.secretKey).filter(isSecretKey),
        };
      });

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
            return repo ? yield* observe(repo) : undefined;
          }
          if (!olds?.projectId) return undefined;
          const found = yield* findByName(olds.projectId, yield* repoName(id, olds));
          return found ? Unowned(yield* observe(found)) : undefined;
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
                retryPropagation,
                Effect.catchTag("RepoNameInUse", () =>
                  awaitVisible(findByName(news.projectId, name), `repository ${name}`),
                ),
              );
            repo = yield* waitActive(created.id);
          } else if (repo.state !== undefined && repo.state !== "active") {
            repo = yield* waitActive(repo.id);
          }

          // Sync visibility against the observed value.
          const visibility = news.visibility ?? "private";
          if ((repo.visibility ?? "private") !== visibility) {
            yield* client.core(Entire.repos.setRepoVisibility({ repoId: repo.id, visibility }));
            repo = { ...repo, visibility };
          }

          // Observe the rest. This also blocks until the repository has
          // reached its cell, where its settings and agents are addressed.
          const observed = yield* observe(repo);
          const repoId = repo.id;
          const repo_id = repo.id;
          const cell = client.cell(cellUrl(repo));

          // Sync branch protection -- the rule set is owned whole.
          let branchProtection = observed.branchProtection;
          if (news.branchProtection !== undefined) {
            const desired = normalizeRules(news.branchProtection);
            if (JSON.stringify(desired) !== JSON.stringify(observed.branchProtection)) {
              const stored = yield* client.core(
                Entire.repos.setBranchProtection({ repoId, rules: desired }),
              );
              branchProtection = normalizeRules(stored.rules);
            }
          }

          // Sync settings -- declared ones only, each group when it differs.
          const settings = {
            trailsEnabled: news.trailsEnabled ?? observed.trailsEnabled,
            runnersEnabled: news.runnersEnabled ?? observed.runnersEnabled,
            autoRunOnPush: news.autoRunOnPush ?? observed.autoRunOnPush,
            publicSharingEnabled: news.publicSharingEnabled ?? observed.publicSharingEnabled,
          };
          if (settings.trailsEnabled !== observed.trailsEnabled) {
            yield* cell(
              Entire.repoSettings.updateRepoTrailSettings({
                repo_id,
                trails_enabled: settings.trailsEnabled,
              }),
            );
          }
          if (
            settings.runnersEnabled !== observed.runnersEnabled ||
            settings.autoRunOnPush !== observed.autoRunOnPush
          ) {
            yield* cell(
              Entire.repoSettings.updateRepoRunnerSettings({
                repo_id,
                runners_enabled: settings.runnersEnabled,
                auto_run_on_push: settings.autoRunOnPush,
              }),
            );
          }
          if (settings.publicSharingEnabled !== observed.publicSharingEnabled) {
            yield* cell(
              Entire.repoSettings.updateRepoPublicSharing({
                repo_id,
                enabled: settings.publicSharingEnabled,
              }),
            );
          }

          // Sync secrets -- values are unreadable, so declared keys are
          // always written; observed keys left out are removed.
          let secretKeys = observed.secretKeys;
          if (news.secrets !== undefined) {
            const declared = Object.entries(news.secrets).filter(
              (entry): entry is [RepoSecretKey, Redacted.Redacted<string>] =>
                isSecretKey(entry[0]) && entry[1] !== undefined,
            );
            for (const [secretKey, value] of declared) {
              yield* cell(Entire.repoSettings.setRepoSecret({ repo_id, secretKey, value }));
            }
            const keep = new Set(declared.map(([key]) => key));
            for (const secretKey of observed.secretKeys) {
              if (keep.has(secretKey)) continue;
              yield* cell(Entire.repoSettings.deleteRepoSecret({ repo_id, secretKey })).pipe(
                Effect.catchTag("NotFound", () => Effect.void),
              );
            }
            secretKeys = [...keep];
          }

          return { ...coreAttrs(repo), branchProtection, ...settings, secretKeys };
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
