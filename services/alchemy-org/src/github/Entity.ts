import * as GitHub from "alchemy/GitHub";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { parseEntityRef } from "../channel/Channel.ts";
import { connected } from "./Repos.ts";

/** A GitHub entity as GitHub has it — what a thread governs. */
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
  const repos = yield* Effect.forEach(connected, (entry) =>
    Effect.gen(function* () {
      const identity = yield* GitHub.resolveRepository(entry.repository);
      return {
        full: `${identity.owner}/${identity.repository}`,
        getIssue: yield* GitHub.GetIssue(entry.repository),
      };
    }),
  );
  const connectedNames = repos.map((repo) => repo.full).join(", ");

  return (ref: string): Effect.Effect<Entity, BadRef> =>
    Effect.gen(function* () {
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
    });
});
