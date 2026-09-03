import * as AI from "alchemy/AI";
import * as GitHub from "alchemy/GitHub";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as S from "effect/Schema";
import { companions } from "../github/Repos.ts";

const branch = AI.Parameter("branch", S.String)`
The pull request's HEAD branch name (readDiff's "head -> base" line).
Companion pull requests are opened from a branch of the SAME name in
the companion repository — that is the convention that pairs them.`;

/**
 * Find a pull request's COMPANIONS — pull requests of the same branch
 * name in the repositories alchemy depends on (`Repos.companions`:
 * `distilled`, the SDK factory pinned as a submodule; `floci`, the AWS
 * emulator). Read-only; a GitHub search, not a checkout.
 */
export class FindCompanions extends (AI.Tool<FindCompanions>(import.meta)(
  "findCompanions",
)`
Find the companion pull requests of ${branch} in alchemy's dependency
repositories (distilled, floci): for each, its number, title, state,
whether it merged, its HEAD commit, and — for a repository pinned as a
submodule — the path whose recorded commit you compare against (run
'git ls-tree HEAD <path>' in your checkout: the pin must be the
companion's head or its merge commit). A repository with no companion
is reported as such; whether one was NEEDED is your judgment.`) {}

/** One `pulls.list` per companion repository, filtered by head ref. */
export const FindCompanionsLive = Layer.effect(
  FindCompanions,
  Effect.gen(function* () {
    const searches = yield* Effect.forEach(companions, (entry) =>
      Effect.gen(function* () {
        const identity = yield* GitHub.resolveRepository(entry.repository);
        const list = yield* GitHub.ListPullRequests(entry.repository);
        return {
          full: `${identity.owner}/${identity.repository}`,
          submodule: entry.submodule,
          list,
        };
      }),
    );

    return ((input: { branch: string }) =>
      Effect.gen(function* () {
        const reports = yield* Effect.forEach(
          searches,
          (search) =>
            search
              .list({
                state: "all",
                sort: "updated",
                direction: "desc",
                per_page: 50,
              })
              .pipe(
                Effect.map((pulls) => {
                  const matches = pulls.filter(
                    (pull) => pull.head.ref === input.branch,
                  );
                  const pin =
                    search.submodule === undefined
                      ? ""
                      : ` (pinned by the alchemy tree at '${search.submodule}')`;
                  if (matches.length === 0) {
                    return `${search.full}${pin}: no pull request from branch '${input.branch}'`;
                  }
                  return [
                    `${search.full}${pin}:`,
                    ...matches.map(
                      (pull) =>
                        `  #${pull.number} ${pull.title} — ${pull.state}${
                          pull.merged_at !== null
                            ? ` (merged${pull.merge_commit_sha ? ` as ${pull.merge_commit_sha}` : ""})`
                            : ""
                        }; head ${pull.head.sha}; ${pull.html_url}`,
                    ),
                  ].join("\n");
                }),
                Effect.catch((error) =>
                  Effect.succeed(
                    `${search.full}: ${error.operation} failed: ${error.message}`,
                  ),
                ),
              ),
          { concurrency: companions.length },
        );
        return reports.join("\n");
      })) as never;
  }),
);
