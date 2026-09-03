import * as AI from "alchemy/AI";
import * as GitHub from "alchemy/GitHub";
import { Self } from "alchemy/Self";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as S from "effect/Schema";
import { publishTargets } from "../github/Repos.ts";
import { Proposals } from "../github/Proposals.ts";

const branch = AI.Parameter("branch", S.String)`
Branch name to publish the tree's current HEAD as (e.g.
"agent/fix-runner-timeout"). Never a protected branch — publish a
topic branch and open a pull request.`;

const title = AI.Parameter("title", S.String)`
Pull request title — conventional-commit style, under 70 characters.`;

const body = AI.Parameter("body", S.String)`
Pull request description (GitHub markdown). Lead with the summary;
keep it minimal and concrete.`;

const head = AI.Parameter("head", S.String)`
The branch holding your work — the one you pushed with pushBranch.`;

const base = AI.Parameter("base", S.optionalKey(S.String))`
The branch to merge into (default: the checkout's own branch).`;

export class PushBranch extends (AI.Tool<PushBranch>()("pushBranch")`
Publish your work: push the tree's current HEAD to the origin
repository as ${branch}. Commit first (bash: git add / git commit) —
this pushes exactly what HEAD points at. Authentication is handled
for you.`) {}

export class OpenPullRequest extends (AI.Tool<OpenPullRequest>()(
  "openPullRequest",
)`
PROPOSE a pull request on the origin repository: ${head} into ${base},
titled ${title}, described by ${body}. Push the branch first with
pushBranch. The pull request is not opened by you: the operator
accepts the proposal in the UI (it opens then) or declines it — you
are told either way.`) {}

/**
 * The credential the publish pair authenticates with — a runtime read
 * of a GitHub token. A SEAM by design: production mints it from the
 * host's FQN-memoized `PersonalAccessToken` resource
 * ({@link PublishTokenLive}); tests provide a literal from the
 * environment without any stack machinery.
 */
export class PublishToken extends Context.Service<
  PublishToken,
  Effect.Effect<Redacted.Redacted<string>>
>()("alchemy-org/PublishToken") {}

/**
 * ONE token resource per host, FQN-memoized — the SAME
 * `${LogicalId}GitHubToken` every `GitHub.*Http` binding on this
 * Worker shares (the BindingHttp convention). Yielding `value` at
 * layer init binds it into the deployed environment; the returned
 * Effect reads it back at runtime.
 */
export const PublishTokenLive = Layer.effect(
  PublishToken,
  Effect.gen(function* () {
    const self = yield* Self;
    const token = yield* GitHub.PersonalAccessToken(
      `${self.LogicalId}GitHubToken`,
    );
    return yield* token.value;
  }),
);

/** Run one git command in the sandbox tree; failures are model-visible. */
const gitIn =
  (sandbox: AI.Sandbox["Service"]) =>
  (args: ReadonlyArray<string>, options?: { timeout?: number }) =>
    Effect.gen(function* () {
      const result = yield* sandbox
        .exec("git", args, { timeout: options?.timeout ?? 120_000 })
        .pipe(Effect.mapError((error) => `git ${args[0]}: ${String(error)}`));
      if (!result.success) {
        return yield* Effect.fail(
          `git ${args.join(" ")} failed (exit ${result.exitCode}):\n${result.stderr}`,
        );
      }
      return result.stdout.trim();
    });

/** The origin repository's identity, read from the tree itself. */
const originOf = (git: ReturnType<typeof gitIn>) =>
  Effect.gen(function* () {
    const url = yield* git(["remote", "get-url", "origin"]);
    const match = url.match(/github\.com[/:]([^/\s]+)\/([^/\s]+?)(?:\.git)?$/);
    if (match === null) {
      return yield* Effect.fail(
        `origin is not a github.com remote: ${url} — pushBranch/openPullRequest publish to the tree's origin`,
      );
    }
    return { owner: match[1]!, repository: match[2]! };
  });

/**
 * Push over the session sandbox: the token rides the push URL for the
 * one command (never written to the tree, never stored in the image).
 */
export const PushBranchLive = Layer.effect(
  PushBranch,
  Effect.gen(function* () {
    const sandbox = yield* AI.Sandbox;
    const token = yield* PublishToken;
    const git = gitIn(sandbox);

    return ((input: { branch: string }) =>
      Effect.gen(function* () {
        const origin = yield* originOf(git);
        const value = Redacted.value(yield* token);
        const pushUrl = `https://x-access-token:${value}@github.com/${origin.owner}/${origin.repository}.git`;
        const output = yield* git(
          ["push", pushUrl, `HEAD:refs/heads/${input.branch}`],
          { timeout: 300_000 },
        ).pipe(
          // the push URL carries the credential — never echo it back
          Effect.mapError((error) => error.replaceAll(value, "<token>")),
        );
        return `pushed HEAD to ${origin.owner}/${origin.repository}@${input.branch}\n${output}`.trim();
      })) as never;
  }),
);

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
