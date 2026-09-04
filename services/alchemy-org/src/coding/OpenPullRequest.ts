import * as AI from "alchemy/AI";
import * as GitHub from "alchemy/GitHub";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as S from "effect/Schema";
import { Proposals } from "../github/Proposals.ts";
import { publishTargets } from "../github/Repos.ts";
import { gitIn, originOf } from "./Origin.ts";

const title = AI.Parameter("title", S.String)`
Pull request title — conventional-commit style, under 70 characters.`;

const body = AI.Parameter("body", S.String)`
Pull request description (GitHub markdown). Lead with the summary;
keep it minimal and concrete.`;

const head = AI.Parameter("head", S.String)`
The branch holding your work — the one you pushed with pushBranch.`;

const base = AI.Parameter("base", S.optionalKey(S.String))`
The branch to merge into (default: the checkout's own branch).`;

export class OpenPullRequest extends (AI.Tool<OpenPullRequest>(import.meta)(
  "openPullRequest",
)`
PROPOSE a pull request on the origin repository: ${head} into ${base},
titled ${title}, described by ${body}. Push the branch first with
pushBranch. The pull request is not opened by you: the operator
accepts the proposal in the UI (it opens then) or declines it — you
are told either way.`) {}

/**
 * PROPOSE the pull request: the tree's `origin` names the target (one
 * of {@link publishTargets} — anything else fails closed), the request
 * is filed with {@link Proposals}, and the OPERATOR opens it from the
 * UI (github/ProposalActions.ts performs the `CreatePullRequest` call
 * then). The tool never touches GitHub itself. The targets are
 * deferred `Repository` identity handles — resolved statically, never
 * provisioned, so the org still claims no ownership of the
 * repositories it contributes to.
 */
export const OpenPullRequestLive = Layer.effect(
  OpenPullRequest,
  Effect.gen(function* () {
    const sandbox = yield* AI.Sandbox;
    const proposals = yield* Proposals;
    const git = gitIn(sandbox);

    const targets = publishTargets.map((repo) => {
      const identity = GitHub.repositoryIdentity(repo);
      if (identity === undefined) {
        throw new Error(
          "publishTargets must declare owner/name as plain strings",
        );
      }
      return `${identity.owner}/${identity.repository}`;
    });

    return ((input: {
      head: string;
      base?: string;
      title: string;
      body: string;
    }) =>
      Effect.gen(function* () {
        // per-session identity — handlers run under the session's own
        // context (the layer builds in the shared per-isolate graph)
        const thread = yield* AI.Thread;
        const origin = yield* originOf(git);
        const repo = `${origin.owner}/${origin.repository}`;
        if (!targets.includes(repo)) {
          return yield* Effect.fail(
            `the tree's origin ${repo} is not a repository this deploy publishes to — targets: ${targets.join(", ")}`,
          );
        }
        const base =
          input.base ??
          (yield* git(["rev-parse", "--abbrev-ref", "HEAD"]).pipe(
            Effect.orElseSucceed(() => "main"),
          ));

        const proposal = yield* proposals.propose({
          session: { term: "Engineer", key: thread.key },
          repo,
          summary: `open pull request "${input.title}" (${input.head} → ${base})`,
          payload: {
            kind: "pull_request",
            title: input.title,
            body: input.body,
            head: input.head,
            base,
          },
        });
        return (
          `pull request proposed as ${proposal.id} on ${repo} (${input.head} → ${base}) — ` +
          `awaiting the operator, who opens it from the UI or declines. You will be told the outcome.`
        );
      })) as never;
  }),
);
