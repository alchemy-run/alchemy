import * as AI from "alchemy/AI";
import * as GitHub from "alchemy/GitHub";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as S from "effect/Schema";
import { publishTargets } from "../github/Repos.ts";
import { gitIn, originOf } from "./Origin.ts";

const title = AI.Thing("title", S.String)`
  Pull request title — conventional-commit style, under 70 characters.`;

const body = AI.Thing("body", S.String)`
  Pull request description (GitHub markdown). Lead with the summary;
  keep it minimal and concrete.`;

const head = AI.Thing("head", S.String)`
  The branch holding your work — the one you pushed with pushBranch.`;

const base = AI.Thing("base", S.optionalKey(S.String))`
  The branch to merge into (default: the checkout's own branch).`;

const url = AI.Thing("url", S.String)`
  The opened pull request's html URL.`;

const number = AI.Thing("number", S.Int)`
  The opened pull request's number.`;

export class OpenPullRequest extends (AI.Tool<OpenPullRequest>(import.meta)(
  "openPullRequest",
)`
  OPEN a pull request on the origin repository: ${head} into ${base},
  titled ${title}, described by ${body} — answers ${AI.out(url, number)}.
  Push the branch first with pushBranch. The pull request opens on
  GitHub immediately.`) {}

/**
 * OPEN the pull request directly: the tree's `origin` names the target
 * (one of {@link publishTargets} — anything else fails closed) and the
 * `CreatePullRequest` write happens here, on the org's own credential.
 * The targets are deferred `Repository` identity handles — resolved
 * statically, never provisioned, so the org still claims no ownership
 * of the repositories it contributes to.
 */
export const OpenPullRequestLive = Layer.effect(
  OpenPullRequest,
  Effect.gen(function* () {
    const sandbox = yield* AI.Sandbox;
    const git = gitIn(sandbox);

    const writers = yield* Effect.forEach(
      publishTargets,
      Effect.fn(function* (target) {
        const identity = yield* GitHub.resolveRepository(target);
        return {
          repo: `${identity.owner}/${identity.repository}`,
          create: yield* GitHub.CreatePullRequest(target),
        };
      }),
    );

    return Effect.fn(function* (input: {
      head: string;
      base?: string;
      title: string;
      body: string;
    }) {
      const origin = yield* originOf(git);
      const repo = `${origin.owner}/${origin.repository}`;
      const writer = writers.find((w) => w.repo === repo);
      if (writer === undefined) {
        return yield* Effect.fail(
          `the tree's origin ${repo} is not a repository this deploy publishes to — targets: ${writers.map((w) => w.repo).join(", ")}`,
        );
      }
      const base =
        input.base ??
        (yield* git(["rev-parse", "--abbrev-ref", "HEAD"]).pipe(
          Effect.orElseSucceed(() => "main"),
        ));
      const pull = yield* writer
        .create({
          title: input.title,
          body: input.body,
          head: input.head,
          base,
        })
        .pipe(
          Effect.mapError(
            (error) => `createPullRequest failed: ${error.message}`,
          ),
        );
      return { url: pull.html_url, number: pull.number };
    }) as never;
  }),
);
