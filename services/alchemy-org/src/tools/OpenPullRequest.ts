import * as AI from "alchemy/AI";
import * as Git from "alchemy/Git";
import * as GitHub from "alchemy/GitHub";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as S from "effect/Schema";
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";
import { runProcess } from "../lib/ProcessRunner.ts";
import { ToolOutputStore } from "../lib/ToolOutputStore.ts";
import { Ledger } from "../services/Ledger.ts";
import { prLinkKey, testAlchemy } from "../Repos.ts";
import { body, IssueRef, title } from "../Vocabulary.ts";

const resolves = AI.Parameter("issue", S.optionalKey(IssueRef))`
The issue this pull request resolves, when there is one — the branch
name, commit message, and the recorded PR→issue link derive from it.
Omit for pull requests that resolve no issue (a scheduled maintenance
pass).`;

export class OpenPullRequest extends AI.Tool<OpenPullRequest>()(
  "openPullRequest",
)`
Open a pull request from the work in the workspace: commits
everything to a branch, pushes it, and opens the PR with ${title} and
${body}, optionally resolving ${resolves}. Returns the created pull
request reference.` {}

/** The bot's commit identity — visible in the sandbox repo's history. */
const GIT_IDENTITY = [
  "-c",
  "user.name=alchemy-org[bot]",
  "-c",
  "user.email=bot@alchemy.run",
];

/**
 * LOCAL physics over the RUN'S OWN worktree: the handler derives the
 * same `AI.Thread` key the Engineer's turn checked out with, so
 * `Git.Workspaces.checkout` is a cache hit landing in the exact tree
 * the agent worked in. Branch → commit → push → `pulls.create`; every
 * step's failure is MODEL-VISIBLE (a tool result the agent reacts to —
 * "nothing to commit" or "PR already exists" are situations to handle,
 * not defects). The worktree keeps its branch afterwards: isolation
 * means there is no shared `main` checkout to restore.
 */
export const OpenPullRequestLive = Layer.effect(
  OpenPullRequest,
  Effect.gen(function* () {
    const workspaces = yield* Git.Workspaces;
    const remote = GitHub.remote(testAlchemy);
    const createPullRequest = yield* GitHub.CreatePullRequest(testAlchemy);
    const ledger = yield* Ledger;
    const environment = yield* Effect.context<
      ChildProcessSpawner | ToolOutputStore
    >();

    const git = (cwd: string, args: ReadonlyArray<string>) =>
      runProcess({
        command: "git",
        args: [...GIT_IDENTITY, ...args],
        cwd,
        timeoutSeconds: 60,
        maxLines: 100,
        maxBytes: 10_000,
        preview: "tail",
      }).pipe(
        Effect.flatMap((result) =>
          result.exitCode === 0
            ? Effect.succeed(result.stdout.text.trim())
            : Effect.fail(
                `git ${args[0]} failed (exit ${result.exitCode}): ${result.stderr.text || result.stdout.text}`,
              ),
        ),
      );

    return ((input: {
      issue?: { owner: string; repository: string; number: number };
      title: string;
      body: string;
    }) =>
      Effect.gen(function* () {
        // the run's worktree: same key as the Engineer's turn → cache hit
        const { key } = yield* AI.Thread;
        const workspace = yield* workspaces
          .checkout({ key, remote })
          .pipe(Effect.mapError((error) => error.message));

        // issue-less runs (a scheduled pass) branch by their run key
        const branch =
          input.issue !== undefined
            ? `factory/issue-${input.issue.number}`
            : `factory/${key.replaceAll(/[^a-zA-Z0-9._-]+/g, "-")}`;

        // the worktree's uncommitted work rides checkout -B onto the branch
        yield* git(workspace.root, ["checkout", "-B", branch]);
        yield* git(workspace.root, ["add", "-A"]);

        const status = yield* git(workspace.root, ["status", "--porcelain"]);
        if (status === "") {
          return yield* Effect.fail(
            "nothing to commit — the workspace has no changes; make the fix before opening a pull request",
          );
        }

        yield* git(workspace.root, [
          "commit",
          "-m",
          input.issue !== undefined
            ? `${input.title} (#${input.issue.number})`
            : input.title,
        ]);
        // force-with-lease: re-running the same key updates its branch
        yield* git(workspace.root, [
          "push",
          "--force-with-lease",
          "-u",
          "origin",
          branch,
        ]);

        const pull = yield* createPullRequest({
          title: input.title,
          body: input.body,
          head: branch,
          base: "main",
        }).pipe(
          Effect.mapError(
            (error) =>
              `${error.operation} failed: ${error.message} — if a PR for ` +
              `${branch} already exists, the push above updated it; cite that one`,
          ),
        );

        // the PR→issue link is born HERE, structured — record it so
        // routing/grouping look it up instead of parsing prose
        if (input.issue !== undefined) {
          yield* ledger.put(
            prLinkKey(
              `${input.issue.owner}/${input.issue.repository}`,
              pull.number,
            ),
            input.issue.number,
          );
        }

        const identity = yield* GitHub.resolveRepository(testAlchemy);
        return {
          opened: pull.html_url,
          pr: {
            owner: identity.owner,
            repository: identity.repository,
            number: pull.number,
            url: pull.html_url,
          },
        };
      }).pipe(Effect.provide(environment))) as never;
  }),
);
