import * as AI from "alchemy/AI";
import * as GitHub from "alchemy/GitHub";
import { Self } from "alchemy/Self";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as S from "effect/Schema";
import { Approvals } from "../services/Approvals.ts";

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

export class PushBranch extends AI.Tool<PushBranch>()("pushBranch")`
Publish your work: push the tree's current HEAD to the origin
repository as ${branch}. Commit first (bash: git add / git commit) —
this pushes exactly what HEAD points at. Authentication is handled
for you.` {}

export class OpenPullRequest extends AI.Tool<OpenPullRequest>()(
  "openPullRequest",
)`
Open a pull request on the origin repository: ${head} into ${base},
titled ${title}, described by ${body}. Push the branch first with
pushBranch. Returns the pull request URL.` {}

/**
 * ONE token resource per host, FQN-memoized — the SAME
 * `${LogicalId}GitHubToken` every `GitHub.*Http` binding on this
 * Worker shares (the BindingHttp convention). Yielding `value` at
 * layer init binds it into the deployed environment; the returned
 * Effect reads it back at runtime.
 */
const mintToken = Effect.gen(function* () {
  const Token = yield* GitHub.PersonalAccessToken;
  const self = yield* Self;
  const token = yield* Token(`${self.LogicalId}GitHubToken`, {});
  return yield* token.value;
});

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
    const token = yield* mintToken;
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
          Effect.mapError((error) =>
            error.replaceAll(value, "<token>"),
          ),
        );
        return `pushed HEAD to ${origin.owner}/${origin.repository}@${input.branch}\n${output}`.trim();
      })) as never;
  }),
);

/**
 * Open the pull request against the tree's origin over the GitHub
 * REST API — no `Repository` resource involved, because the org must
 * never claim ownership of the repository it is contributing to.
 * Gated by {@link Approvals} (disarmed deploys answer immediately).
 */
export const OpenPullRequestLive = Layer.effect(
  OpenPullRequest,
  Effect.gen(function* () {
    const sandbox = yield* AI.Sandbox;
    const approvals = yield* Approvals;
    const token = yield* mintToken;
    const git = gitIn(sandbox);

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
        const base =
          input.base ??
          (yield* git(["rev-parse", "--abbrev-ref", "HEAD"]).pipe(
            Effect.orElseSucceed(() => "main"),
          ));

        const outcome = yield* approvals.ask({
          session: { term: "Engineer", key: thread.key },
          action: `open pull request on ${origin.owner}/${origin.repository}: "${input.title}" (${input.head} → ${base})`,
        });
        if (outcome !== "allowed-once") {
          return yield* Effect.fail(
            `the operator did not approve opening this pull request (${outcome}) — ask them in chat, then try again`,
          );
        }

        const value = Redacted.value(yield* token);
        const response = yield* Effect.tryPromise({
          try: () =>
            fetch(
              `https://api.github.com/repos/${origin.owner}/${origin.repository}/pulls`,
              {
                method: "POST",
                headers: {
                  accept: "application/vnd.github+json",
                  authorization: `Bearer ${value}`,
                  "user-agent": "alchemy-org",
                },
                body: JSON.stringify({
                  title: input.title,
                  body: input.body,
                  head: input.head,
                  base,
                }),
              },
            ).then(async (res) => ({ status: res.status, json: await res.json() })),
          catch: (error) => `pulls.create failed: ${String(error)}`,
        });
        const pull = response.json as {
          html_url?: string;
          number?: number;
          message?: string;
          errors?: Array<{ message?: string }>;
        };
        if (response.status !== 201) {
          const detail =
            pull.errors?.map((e) => e.message).join("; ") ?? pull.message;
          return yield* Effect.fail(
            `pulls.create returned ${response.status}: ${detail ?? "unknown error"}`,
          );
        }
        return `opened pull request #${pull.number}: ${pull.html_url}`;
      })) as never;
  }),
);
