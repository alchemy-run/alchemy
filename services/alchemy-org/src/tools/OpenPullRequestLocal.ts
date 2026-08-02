/**
 * LOCAL OpenPullRequest physics — git worktree + GitHub API. Worker
 * code must not import this module (see SandboxToolbox.ts).
 */
import * as AI from "alchemy/AI";
import * as Git from "alchemy/Git";
import * as GitHub from "alchemy/GitHub";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";
import { runProcess } from "../lib/ProcessRunner.ts";
import { ToolOutputStore } from "../lib/ToolOutputStore.ts";
import { Ledger } from "../services/Ledger.ts";
import { prLinkKey, testAlchemy } from "../Repos.ts";
import { GIT_IDENTITY, OpenPullRequest } from "./OpenPullRequest.ts";

/**
 * LOCAL physics over the RUN'S OWN worktree: the handler derives the
 * same `AI.Thread` key the Engineer's turn checked out with, so
 * `Git.Workspaces.checkout` is a cache hit landing in the exact tree
 * the agent worked in.
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
        const { key } = yield* AI.Thread;
        const workspace = yield* workspaces
          .checkout({ key, remote })
          .pipe(Effect.mapError((error) => error.message));

        const branch =
          input.issue !== undefined
            ? `factory/issue-${input.issue.number}`
            : `factory/${key.replaceAll(/[^a-zA-Z0-9._-]+/g, "-")}`;

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
