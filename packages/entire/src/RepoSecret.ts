import * as Entire from "@distilled.cloud/entire";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import { makeClient, retryCellNotFound } from "./internal/Client.ts";
import type { Providers } from "./Providers.ts";

/** The model-provider keys Entire's runners read from a repository. */
export type RepoSecretKey = "api_key_anthropic" | "api_key_openai";

export type RepoSecretProps = {
  /** ID of the repository. Changing it replaces the secret. */
  repoId: string;
  /**
   * Which key to set. Entire stores only model-provider API keys, which
   * its agent runners use. Changing it replaces the secret.
   */
  key: RepoSecretKey;
  /** The API key. Stored encrypted and never returned by Entire. */
  value: Redacted.Redacted<string>;
};

export type RepoSecret = Resource<
  "Entire.RepoSecret",
  RepoSecretProps,
  {
    /** ID of the repository. */
    repoId: string;
    /** The key that is set. */
    key: RepoSecretKey;
  },
  never,
  Providers
>;

/**
 * A model-provider API key that Entire's agent runners use for a
 * {@link Repo}. Entire accepts two keys, `api_key_anthropic` and
 * `api_key_openai`. The value is write-only: Entire never returns it, so a
 * deploy always writes it again.
 *
 * ### Setting an API Key
 * **Example:** Anthropic key from an Alchemy secret
 * ```typescript
 * yield* Entire.RepoSecret("anthropic", {
 *   repoId: repo.id,
 *   key: "api_key_anthropic",
 *   value: yield* Config.redacted("ANTHROPIC_API_KEY"),
 * });
 * ```
 *
 * @resource
 * @product Repo
 */
export const RepoSecret = Resource<RepoSecret>("Entire.RepoSecret");

export const RepoSecretProvider = () =>
  Provider.effect(
    RepoSecret,
    Effect.gen(function* () {
      const client = yield* makeClient;

      /** Repository secrets live in the repository's cell. */
      const cellOf = Effect.fn(function* (repoId: string) {
        const repo = yield* client.core(Entire.repos.getRepo({ repoId }));
        return client.cell(repo.placements?.find((p) => p.id === repo.id)?.apiBaseUrl);
      });

      const isSet = Effect.fn(function* (repoId: string, key: string) {
        const cell = yield* cellOf(repoId);
        const listed = yield* cell(
          retryCellNotFound(Entire.repoSettings.listRepoSecrets({ repo_id: repoId })),
        );
        return (listed.items ?? []).some((item) => item.secretKey === key);
      });

      return {
        stables: ["repoId", "key"],
        // Write-only values scoped to a repository; listed through it.
        list: () => Effect.succeed([]),
        diff: Effect.fn(function* ({ news, output }) {
          if (!isResolved(news) || !output) return undefined;
          if (news.repoId !== output.repoId || news.key !== output.key) {
            return { action: "replace" } as const;
          }
          return undefined;
        }),
        read: Effect.fn(function* ({ olds, output }) {
          const repoId = output?.repoId ?? olds?.repoId;
          const key = output?.key ?? olds?.key;
          if (!repoId || !key) return undefined;
          const present = yield* isSet(repoId, key).pipe(
            Effect.catchTag("NotFound", () => Effect.succeed(false)),
          );
          return present ? { repoId, key } : undefined;
        }),
        reconcile: Effect.fn(function* ({ news }) {
          // The value is never readable, so there is nothing to diff it
          // against: write it every time.
          const cell = yield* cellOf(news.repoId);
          yield* cell(
            retryCellNotFound(
              Entire.repoSettings.setRepoSecret({
                repo_id: news.repoId,
                secretKey: news.key,
                value: news.value,
              }),
            ),
          );
          return { repoId: news.repoId, key: news.key };
        }),
        delete: Effect.fn(function* ({ output }) {
          const cell = yield* cellOf(output.repoId).pipe(
            Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
          );
          if (!cell) return;
          yield* cell(
            Entire.repoSettings.deleteRepoSecret({ repo_id: output.repoId, secretKey: output.key }),
          ).pipe(Effect.catchTag("NotFound", () => Effect.void));
        }),
      };
    }),
  );
