import type * as Git from "alchemy/Git";
import * as GitHub from "alchemy/GitHub";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { parsePullKey, pullRequestRef } from "../github/PullRequest.ts";
import { connected } from "../github/Repos.ts";

/** Thread keys are `<session>` or `<session>::<thread>` — the session
 *  part names the machine (and thus the one worktree on it). */
export const sessionOf = (key: string): string => {
  const at = key.indexOf("::");
  return at < 0 ? key : key.slice(0, at);
};

/** The tree a session works in, derived from its key. */
export interface SessionTree {
  /** `owner/repo`. */
  readonly repo: string;
  readonly remote: Git.Remote;
  /** The ref the tree lands on; the remote's default branch when absent. */
  readonly ref: string | undefined;
  /** Re-fetch the ref when the tree is first touched — a pull request's
   *  head moves; a session resumed later starts from it as it is now. */
  readonly fresh: boolean;
  /** Set for a PULL REQUEST session (`owner/repo#N`). */
  readonly pull:
    | {
        readonly number: number;
        readonly title: string;
        readonly author: string;
        readonly head: string;
        readonly base: string;
        /** The checked-out ref: the head branch when the PR lives in
         *  this repository (pushes land in the PR), `pull/N/head` for a
         *  fork. */
        readonly ref: string;
      }
    | undefined;
}

/**
 * WHICH repository tree a session works in — a pure function of the
 * session key over the STATIC connected list (Repos.ts), plus one
 * GitHub read for pull-request sessions (the head ref):
 *
 * - `<owner>/<repo>/<name>` — a coding session on the repo's default
 *   branch (the baked tree is adopted in place; no fetch).
 * - `<owner>/<repo>#<n>` — a pull-request session: the PR's head, which
 *   the tree re-fetches on first touch.
 * - anything else (legacy `main`, `t-…`) — `undefined`: the machine's
 *   baked tree, as is.
 *
 * Resolved lazily and memoized per session: the charter's stance reads
 * it for its prose, the sandbox wrapper (`SandboxCheckout`) for the
 * converge — one GitHub call between them, and NEITHER at INIT unless
 * the stance asks.
 */
export class SessionRepo extends Context.Service<
  SessionRepo,
  {
    readonly resolve: (
      threadKey: string,
    ) => Effect.Effect<SessionTree | undefined, string>;
  }
>()("alchemy-org/SessionRepo") {}

export const SessionRepoLive = Layer.effect(
  SessionRepo,
  Effect.gen(function* () {
    const entries = yield* Effect.forEach(
      connected.filter((entry) => entry.sessions || entry.reviews),
      (entry) =>
        Effect.gen(function* () {
          const identity = yield* GitHub.resolveRepository(entry.repository);
          const getPullRequest = yield* GitHub.GetPullRequest(entry.repository);
          return {
            full: `${identity.owner}/${identity.repository}`,
            remote: GitHub.remote(entry.repository),
            getPullRequest,
          };
        }),
    );
    const resolved = new Map<string, SessionTree | undefined>();

    const derive = (
      session: string,
    ): Effect.Effect<SessionTree | undefined, string> =>
      Effect.gen(function* () {
        const pullKey = parsePullKey(session);
        for (const entry of entries) {
          if (pullKey !== undefined && pullKey.repo === entry.full) {
            const found = yield* entry
              .getPullRequest({ pull_number: pullKey.number })
              .pipe(
                Effect.mapError(
                  (error) =>
                    `could not read pull request #${pullKey.number} of ${entry.full}: ${error.message}`,
                ),
              );
            const ref = pullRequestRef(found);
            return {
              repo: entry.full,
              remote: entry.remote,
              ref,
              fresh: true,
              pull: {
                number: found.number,
                title: found.title,
                author: found.user?.login ?? "unknown",
                head: found.head.ref,
                base: found.base.ref,
                ref,
              },
            };
          }
          if (session.startsWith(`${entry.full}/`)) {
            return {
              repo: entry.full,
              remote: entry.remote,
              ref: undefined,
              fresh: false,
              pull: undefined,
            };
          }
        }
        return undefined;
      });

    return {
      resolve: (threadKey) =>
        Effect.gen(function* () {
          const session = sessionOf(threadKey);
          if (resolved.has(session)) return resolved.get(session);
          const tree = yield* derive(session);
          resolved.set(session, tree);
          return tree;
        }),
    };
  }),
);
