import * as Entire from "@distilled.cloud/entire";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { makeClient, retryCellNotFound } from "./internal/Client.ts";
import type { Providers } from "./Providers.ts";

export type RepoSettingsProps = {
  /** ID of the repository. Changing it replaces the resource. */
  repoId: string;
  /** Whether Entire records trails for the repository. */
  trailsEnabled?: boolean;
  /** Whether agent runners may run for the repository. */
  runnersEnabled?: boolean;
  /** Whether runners start automatically on push. Requires `runnersEnabled`. */
  autoRunOnPush?: boolean;
  /** Whether sessions of the repository may be shared by public link. */
  publicSharingEnabled?: boolean;
};

export type RepoSettings = Resource<
  "Entire.RepoSettings",
  RepoSettingsProps,
  {
    /** ID of the repository. */
    repoId: string;
    trailsEnabled: boolean;
    runnersEnabled: boolean;
    autoRunOnPush: boolean;
    publicSharingEnabled: boolean;
  },
  never,
  Providers
>;

/**
 * Trail, runner and sharing settings of an Entire {@link Repo}. Only the
 * settings you declare are written; the rest keep their current value and
 * are reported in the attributes. Delete leaves the settings as they are
 * (they are removed with the repository).
 *
 * ### Configuring a Repository
 * **Example:** Run agents on every push
 * ```typescript
 * yield* Entire.RepoSettings("settings", {
 *   repoId: repo.id,
 *   runnersEnabled: true,
 *   autoRunOnPush: true,
 * });
 * ```
 *
 * **Example:** Allow public session links
 * ```typescript
 * yield* Entire.RepoSettings("sharing", {
 *   repoId: repo.id,
 *   publicSharingEnabled: true,
 * });
 * ```
 *
 * @resource
 * @product Repo
 */
export const RepoSettings = Resource<RepoSettings>("Entire.RepoSettings");

export const RepoSettingsProvider = () =>
  Provider.effect(
    RepoSettings,
    Effect.gen(function* () {
      const client = yield* makeClient;

      /** The repository's settings, read from its cell. */
      const observe = Effect.fn(function* (repoId: string) {
        const repo = yield* client.core(Entire.repos.getRepo({ repoId }));
        const cell = client.cell(repo.placements?.find((p) => p.id === repo.id)?.apiBaseUrl);
        const meta = yield* cell(
          retryCellNotFound(Entire.repoDetails.getRepoMeta({ repo_id: repoId })),
        );
        return {
          cell,
          settings: {
            repoId,
            trailsEnabled: meta.trails_enabled,
            runnersEnabled: meta.runners_enabled,
            autoRunOnPush: meta.auto_run_on_push,
            publicSharingEnabled: meta.public_sharing_enabled,
          },
        };
      });

      return {
        stables: ["repoId"],
        // A per-repository setting; listed through its repository.
        list: () => Effect.succeed([]),
        diff: Effect.fn(function* ({ news, output }) {
          if (!isResolved(news) || !output) return undefined;
          if (news.repoId !== output.repoId) return { action: "replace" } as const;
          return undefined;
        }),
        read: Effect.fn(function* ({ olds, output }) {
          const repoId = output?.repoId ?? olds?.repoId;
          if (!repoId) return undefined;
          const observed = yield* observe(repoId).pipe(
            Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
          );
          return observed?.settings;
        }),
        reconcile: Effect.fn(function* ({ news }) {
          const repo_id = news.repoId;
          const { cell, settings } = yield* observe(repo_id);
          const want = {
            trailsEnabled: news.trailsEnabled ?? settings.trailsEnabled,
            runnersEnabled: news.runnersEnabled ?? settings.runnersEnabled,
            autoRunOnPush: news.autoRunOnPush ?? settings.autoRunOnPush,
            publicSharingEnabled: news.publicSharingEnabled ?? settings.publicSharingEnabled,
          };
          // Sync each settings group only when its observed value differs.
          if (want.trailsEnabled !== settings.trailsEnabled) {
            yield* cell(
              Entire.repoSettings.updateRepoTrailSettings({
                repo_id,
                trails_enabled: want.trailsEnabled,
              }),
            );
          }
          if (
            want.runnersEnabled !== settings.runnersEnabled ||
            want.autoRunOnPush !== settings.autoRunOnPush
          ) {
            yield* cell(
              Entire.repoSettings.updateRepoRunnerSettings({
                repo_id,
                runners_enabled: want.runnersEnabled,
                auto_run_on_push: want.autoRunOnPush,
              }),
            );
          }
          if (want.publicSharingEnabled !== settings.publicSharingEnabled) {
            yield* cell(
              Entire.repoSettings.updateRepoPublicSharing({
                repo_id,
                enabled: want.publicSharingEnabled,
              }),
            );
          }
          return { repoId: repo_id, ...want };
        }),
        // The settings are removed with the repository; delete leaves them.
        delete: Effect.fn(function* () {}),
      };
    }),
  );
