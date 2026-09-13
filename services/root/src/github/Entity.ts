import * as AI from "alchemy/AI";
import * as GitHub from "alchemy/GitHub";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as S from "effect/Schema";
import { connected } from "./Repos.ts";

/** `owner/repo#N` → its parts; undefined when the ref is malformed. */
export const parseEntityRef = (
  ref: string,
): { owner: string; repo: string; number: number } | undefined => {
  const match = /^([^/\s#]+)\/([^/\s#]+)#(\d+)$/.exec(ref);
  if (match === null) return undefined;
  return {
    owner: match[1]!,
    repo: match[2]!,
    number: Number(match[3]!),
  };
};

/** A GitHub entity as GitHub has it — what the company governs. */
export interface Entity {
  /** The canonical `owner/repo#N` — the repository as GitHub spells it. */
  readonly ref: string;
  readonly kind: "issue" | "pull";
  readonly title: string;
  /** `open`, `closed`, or `merged` — GitHub's word. */
  readonly state: "open" | "closed" | "merged";
}

/**
 * The ref could not be verified: malformed, a repository the org is not
 * connected to, or an entity that does not exist. The message says
 * which and, for a repository miss, names the connected ones — the
 * model's correction is in the text.
 */
export class BadRef extends Data.TaggedError("BadRef")<{ message: string }> {}

/**
 * Resolve an `owner/repo#N` ref against GitHub — one read per lookup,
 * over the connected repositories only. Every assignment goes through
 * this so an entity is never recorded on the model's word: a model
 * that derives `author/repo#N` from a PR's author login (the fork's
 * owner is not the repository) fails here with the connected list in
 * hand, instead of a phantom entity landing beside the real one.
 *
 * The issues door answers for pull requests too (with a
 * `pull_request` block), so one call settles kind, title, and state.
 */
export const makeEntityLookup = Effect.gen(function* () {
  const repos = yield* Effect.forEach(
    connected,
    Effect.fn(function* (entry) {
      const identity = yield* GitHub.resolveRepository(entry.repository);
      return {
        full: `${identity.owner}/${identity.repository}`,
        getIssue: yield* GitHub.GetIssue(entry.repository),
      };
    }),
  );
  const connectedNames = repos.map((repo) => repo.full).join(", ");

  const lookup: (ref: string) => Effect.Effect<Entity, BadRef> = Effect.fn(
    function* (ref: string) {
      const parsed = parseEntityRef(ref);
      if (parsed === undefined) {
        return yield* new BadRef({ message: `${ref} is not owner/repo#N` });
      }
      const full = `${parsed.owner}/${parsed.repo}`;
      const repo = repos.find(
        (candidate) => candidate.full.toLowerCase() === full.toLowerCase(),
      );
      if (repo === undefined) {
        return yield* new BadRef({
          message: `${full} is not a connected repository (${connectedNames})`,
        });
      }
      const issue = yield* repo.getIssue({ issue_number: parsed.number }).pipe(
        Effect.mapError(
          (error) =>
            new BadRef({
              message:
                error._tag === "GitHub.IssueNotFound"
                  ? `${repo.full}#${parsed.number} does not exist`
                  : `could not read ${repo.full}#${parsed.number}: ${error.message}`,
            }),
        ),
      );
      const pull = issue.pull_request;
      return {
        ref: `${repo.full}#${issue.number}`,
        kind: pull === undefined ? "issue" : "pull",
        title: issue.title,
        state:
          pull !== undefined && pull.merged_at != null
            ? "merged"
            : issue.state === "open"
              ? "open"
              : "closed",
      };
    },
  );
  return lookup;
});

/* ── the read tools — GitHub, on demand, nothing mirrored ─────────── */

const refThing = AI.Thing("ref", S.String)`
  The GitHub entity — "owner/repo#N".`;

/**
 * `read_issue` / `read_pull` — one entity, read fresh from GitHub:
 * title, state, body, and the latest comments. The company's agents
 * read the world on demand; nothing is mirrored.
 */
export const makeEntityTools = Effect.gen(function* () {
  const repos = yield* Effect.forEach(connected, (entry) =>
    Effect.gen(function* () {
      const identity = yield* GitHub.resolveRepository(entry.repository);
      return {
        full: `${identity.owner}/${identity.repository}`,
        getIssue: yield* GitHub.GetIssue(entry.repository),
        getPull: yield* GitHub.GetPullRequest(entry.repository),
        listComments: yield* GitHub.ListIssueComments(entry.repository),
      };
    }),
  );
  const connectedNames = repos.map((repo) => repo.full).join(", ");

  const repoOf = Effect.fn(function* (ref: string) {
    const parsed = parseEntityRef(ref);
    if (parsed === undefined) {
      return yield* new BadRef({ message: `${ref} is not owner/repo#N` });
    }
    const full = `${parsed.owner}/${parsed.repo}`;
    const repo = repos.find(
      (candidate) => candidate.full.toLowerCase() === full.toLowerCase(),
    );
    if (repo === undefined) {
      return yield* new BadRef({
        message: `${full} is not a connected repository (${connectedNames})`,
      });
    }
    return { repo, number: parsed.number };
  });

  const comments = Effect.fn(function* (
    repo: (typeof repos)[number],
    number: number,
  ) {
    const list = yield* repo
      .listComments({ issue_number: number, per_page: 10 })
      .pipe(Effect.orElseSucceed(() => []));
    return list.map((comment) => ({
      author: comment.user?.login ?? "?",
      body: (comment.body ?? "").slice(0, 2_000),
    }));
  });

  const readIssue = yield* AI.Tool("read_issue")`
    Read issue ${refThing} fresh from GitHub — title, state, body, the
    latest comments. Fails with ${BadRef} when the ref is malformed,
    unconnected, or absent.`(
    Effect.fn(function* (p: { ref: string }) {
      const { repo, number } = yield* repoOf(p.ref);
      const issue = yield* repo
        .getIssue({ issue_number: number })
        .pipe(
          Effect.mapError(
            (error) => new BadRef({ message: `could not read ${p.ref}: ${error.message}` }),
          ),
        );
      return {
        ref: `${repo.full}#${issue.number}`,
        title: issue.title,
        state: issue.state,
        body: (issue.body ?? "").slice(0, 6_000),
        comments: yield* comments(repo, number),
      };
    }),
  );

  const readPull = yield* AI.Tool("read_pull")`
    Read pull request ${refThing} fresh from GitHub — title, state,
    branches, body, the latest comments. Fails with ${BadRef} when the
    ref is malformed, unconnected, or absent.`(
    Effect.fn(function* (p: { ref: string }) {
      const { repo, number } = yield* repoOf(p.ref);
      const pull = yield* repo
        .getPull({ pull_number: number })
        .pipe(
          Effect.mapError(
            (error) => new BadRef({ message: `could not read ${p.ref}: ${error.message}` }),
          ),
        );
      return {
        ref: `${repo.full}#${pull.number}`,
        title: pull.title,
        state: pull.merged_at != null ? "merged" : pull.state,
        head: pull.head.ref,
        base: pull.base.ref,
        body: (pull.body ?? "").slice(0, 6_000),
        comments: yield* comments(repo, number),
      };
    }),
  );

  return { readIssue, readPull };
});
