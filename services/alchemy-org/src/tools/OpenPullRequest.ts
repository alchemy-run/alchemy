import * as AI from "alchemy/AI";
import * as GitHub from "alchemy/GitHub";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";
import { runProcess } from "../internal/ProcessRunner.ts";
import { ToolOutputStore } from "../internal/ToolOutputStore.ts";
import { testAlchemy } from "../repos.ts";
import { body, issue, title } from "../vocabulary.ts";
import { Workspace } from "../workspace.ts";

export class OpenPullRequest extends AI.Tool<OpenPullRequest>()(
  "openPullRequest",
)`
Open a pull request resolving ${issue}: commits everything in the
workspace to a branch, pushes it, and opens the PR with ${title} and
${body}. The body must cite the issue ("Closes #N") and the evidence
that its criteria are met. Returns the created pull request reference.` {}

/** The bot's commit identity — visible in the sandbox repo's history. */
const GIT_IDENTITY = [
  "-c",
  "user.name=alchemy-org[bot]",
  "-c",
  "user.email=bot@alchemy.run",
];

/**
 * LOCAL physics over the workspace checkout: branch → commit → push →
 * `pulls.create`. Every step's failure is MODEL-VISIBLE (a tool result
 * the agent reacts to — "nothing to commit" or "PR already exists" are
 * situations to handle, not defects). The workspace is left back on
 * the default branch so the next run starts clean.
 */
export const OpenPullRequestLive = Layer.effect(
  OpenPullRequest,
  Effect.gen(function* () {
    const { root } = yield* Workspace;
    const createPullRequest = yield* GitHub.CreatePullRequest(testAlchemy);
    const environment = yield* Effect.context<
      ChildProcessSpawner | ToolOutputStore
    >();

    const git = (args: ReadonlyArray<string>) =>
      runProcess({
        command: "git",
        args: [...GIT_IDENTITY, ...args],
        cwd: root,
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
      issue: { owner: string; repository: string; number: number };
      title: string;
      body: string;
    }) =>
      Effect.gen(function* () {
        const branch = `factory/issue-${input.issue.number}`;

        // the workspace's uncommitted work rides checkout -B onto the branch
        yield* git(["checkout", "-B", branch]);
        yield* git(["add", "-A"]);

        const status = yield* git(["status", "--porcelain"]);
        if (status === "") {
          yield* git(["checkout", "-"]);
          return yield* Effect.fail(
            "nothing to commit — the workspace has no changes; make the fix before opening a pull request",
          );
        }

        yield* git(["commit", "-m", `${input.title} (#${input.issue.number})`]);
        // force-with-lease: re-running the same issue updates its branch
        yield* git(["push", "--force-with-lease", "-u", "origin", branch]);

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

        // leave the checkout clean for the next run
        yield* git(["checkout", "main"]);

        return {
          opened: pull.html_url,
          pr: {
            owner: input.issue.owner,
            repository: input.issue.repository,
            number: pull.number,
            url: pull.html_url,
          },
        };
      }).pipe(Effect.provide(environment))) as never;
  }),
);
