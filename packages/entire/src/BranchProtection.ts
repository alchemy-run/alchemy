import * as Entire from "@distilled.cloud/entire";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { makeClient } from "./internal/Client.ts";
import type { Providers } from "./Providers.ts";

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

export type BranchProtectionProps = {
  /** ID of the repository to protect. Changing it replaces the resource. */
  repoId: string;
  /** Protection rules, one per ref pattern, each ref at most once. */
  rules: BranchProtectionRule[];
};

export type BranchProtection = Resource<
  "Entire.BranchProtection",
  BranchProtectionProps,
  {
    /** ID of the protected repository. */
    repoId: string;
    /** The rules Entire stored, in order. */
    rules: { ref: string; serverSideMergeOnly: boolean }[];
  },
  never,
  Providers
>;

/**
 * The branch protection rules of an Entire {@link Repo}. A repository has
 * one rule set, so this resource owns all of it: rules Alchemy did not
 * declare are removed on deploy, and delete clears the set.
 *
 * ### Protecting Branches
 * **Example:** Require server-side merges on the default branch
 * ```typescript
 * yield* Entire.BranchProtection("protection", {
 *   repoId: repo.id,
 *   rules: [{ ref: "HEAD", serverSideMergeOnly: true }],
 * });
 * ```
 *
 * **Example:** Protect release branches from force-pushes
 * ```typescript
 * yield* Entire.BranchProtection("protection", {
 *   repoId: repo.id,
 *   rules: [
 *     { ref: "HEAD", serverSideMergeOnly: true },
 *     { ref: "refs/heads/release/*" },
 *   ],
 * });
 * ```
 *
 * @resource
 * @product Repo
 */
export const BranchProtection = Resource<BranchProtection>("Entire.BranchProtection");

const normalize = (rules: ReadonlyArray<{ ref: string; serverSideMergeOnly?: boolean }>) =>
  rules.map((r) => ({ ref: r.ref, serverSideMergeOnly: r.serverSideMergeOnly ?? false }));

export const BranchProtectionProvider = () =>
  Provider.effect(
    BranchProtection,
    Effect.gen(function* () {
      const client = yield* makeClient;
      const get = (repoId: string) => client.core(Entire.repos.getBranchProtection({ repoId }));

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
          const current = yield* get(repoId).pipe(
            Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
          );
          return current ? { repoId, rules: normalize(current.rules) } : undefined;
        }),
        reconcile: Effect.fn(function* ({ news }) {
          const desired = normalize(news.rules);
          const observed = normalize((yield* get(news.repoId)).rules);
          if (JSON.stringify(observed) === JSON.stringify(desired)) {
            return { repoId: news.repoId, rules: observed };
          }
          const stored = yield* client.core(
            Entire.repos.setBranchProtection({ repoId: news.repoId, rules: desired }),
          );
          return { repoId: news.repoId, rules: normalize(stored.rules) };
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* client
            .core(Entire.repos.setBranchProtection({ repoId: output.repoId, rules: [] }))
            .pipe(Effect.catchTag("NotFound", () => Effect.void));
        }),
      };
    }),
  );
