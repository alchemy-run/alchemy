import type * as AI from "alchemy/AI";
import * as Effect from "effect/Effect";

/** A workspace input as the router's address: "name" → "@name",
 *  "@name" passes through, absent stays absent. */
export const atName = (name: string | undefined): string | undefined =>
  name === undefined || name === "" || name.startsWith("@")
    ? name === ""
      ? undefined
      : name
    : `@${name}`;

/** Run one git command in the sandbox tree; failures are model-visible.
 *  `cwd` addresses the workspace the tree lives in (`@<name>`) — absent,
 *  the call runs in the session's implicit tree, which thread-family
 *  sessions do not have (they fail closed with the addressing hint). */
export const gitIn = (sandbox: AI.Sandbox["Service"], cwd?: string) =>
  Effect.fn(function* (
    args: ReadonlyArray<string>,
    options?: { timeout?: number },
  ) {
    const result = yield* sandbox
      .exec("git", args, {
        timeout: options?.timeout ?? 120_000,
        ...(cwd !== undefined ? { cwd } : {}),
      })
      .pipe(Effect.mapError((error) => `git ${args[0]}: ${String(error)}`));
    if (!result.success) {
      return yield* Effect.fail(
        `git ${args.join(" ")} failed (exit ${result.exitCode}):\n${result.stderr}`,
      );
    }
    return result.stdout.trim();
  });

/**
 * The origin repository's identity, read from the tree itself — the
 * publishing tools (`coding/PushBranch.ts`, `coding/OpenPullRequest.ts`)
 * publish to the tree's origin, never to a repository named by the model.
 */
export const originOf = Effect.fn(function* (git: ReturnType<typeof gitIn>) {
  const url = yield* git(["remote", "get-url", "origin"]);
  const match = url.match(/github\.com[/:]([^/\s]+)\/([^/\s]+?)(?:\.git)?$/);
  if (match === null) {
    return yield* Effect.fail(
      `origin is not a github.com remote: ${url} — pushBranch/openPullRequest publish to the tree's origin`,
    );
  }
  return { owner: match[1]!, repository: match[2]! };
});
