import * as AI from "alchemy/AI";
import * as Git from "alchemy/Git";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

/** The host-side script that owns the trees — see its header. Runs at
 *  the workspace root, which is the dev sandbox's root. */
const SCRIPT = "services/alchemy-org/scripts/worktree.ts";

/** What the script prints for a tree. */
interface Tree {
  readonly root: string;
  readonly path: string;
  readonly branch: string;
}

/**
 * `Git.Checkouts` over a sandbox that IS the developer's repository —
 * the dev-mode pairing for `SandboxWorktree` (`AI.SandboxHttp` against
 * `AI.serveSandbox`, see SandboxSession.ts). Each session gets its OWN linked
 * worktree under `.alchemy/worktrees/{key}`, so sessions edit, build,
 * and branch without touching the developer's checkout — and the
 * developer's uncommitted work never leaks into a session's tree.
 *
 * The base of a tree: `ref` when the caller pins one (a PR's head,
 * fetched from `origin` so it is current), else the workspace's own
 * `HEAD` — a dev session works on the code the developer is on, with
 * no network. A ref that is a branch on origin is checked out AS that
 * branch (a PR session sits on the PR's branch, tracking it — `git
 * push` lands in the PR, as on the microVM); otherwise the tree gets
 * its own `ws/{key}` branch. `fresh: true` re-points the branch at the
 * base (force); an existing tree is otherwise adopted as-is
 * (idempotent by key).
 *
 * Submodules: `distilled` is bootstrapped through the repo's own
 * `scripts/bootstrap-distilled-worktree.ts` (the `post-checkout` hook's
 * script) — a worktree of `.git/modules/distilled` at the commit the
 * parent records, sharing the primary checkout's objects. The vendor
 * submodules (`update = none`) stay absent, as in a fresh clone.
 * `node_modules` is NOT installed — a tree is ready in seconds, and
 * `pnpm install` (hardlinks from the shared store) is the session's
 * first build step, not the checkout's.
 *
 * Every verb is ONE `exec` of `scripts/worktree.ts` on the host, which
 * serializes itself with a lock directory. Nothing is locked or
 * memoized in the Worker: workerd cancels a request that only waits on
 * another request's promise ("Promise will never complete"), so a
 * shared semaphore here would take down every concurrent checkout —
 * and a request abandoned by its client (a page reload mid-checkout)
 * leaves the host process running to completion regardless.
 */
export const CheckoutsWorktree = Layer.effect(
  Git.Checkouts,
  Effect.gen(function* () {
    const sandbox = yield* AI.Sandbox;

    /** Run one verb of the script; parsed JSON stdout. */
    const worktree = (
      verb: string,
      key: string,
      flags: ReadonlyArray<string>,
    ) =>
      Effect.gen(function* () {
        const args = [SCRIPT, verb, key, ...flags];
        const command = `bun ${args.join(" ")}`;
        const result = yield* sandbox
          .exec("bun", args, { timeout: 600_000 })
          .pipe(
            Effect.mapError(
              (error) =>
                new Git.GitError({ command, exitCode: -1, stderr: error }),
            ),
          );
        if (!result.success) {
          return yield* Effect.fail(
            new Git.GitError({
              command,
              exitCode: result.exitCode,
              stderr: result.stderr.trim() || result.stdout.trim(),
            }),
          );
        }
        const text = result.stdout.trim();
        if (text.length === 0) return null;
        return yield* Effect.try({
          try: () => JSON.parse(text) as Tree | null,
          catch: (cause) =>
            new Git.GitError({
              command,
              exitCode: result.exitCode,
              stderr: `unparseable tree: ${String(cause)}: ${text}`,
            }),
        });
      });

    /** Whatever `origin` the workspace tracks — the remote a `get`
     *  reports when nobody told us one. */
    const originRemote: Effect.Effect<Git.Remote, Git.GitError> = sandbox
      .exec("git", ["remote", "get-url", "origin"], { timeout: 30_000 })
      .pipe(
        Effect.mapError(
          (error) =>
            new Git.GitError({
              command: "git remote get-url origin",
              exitCode: -1,
              stderr: error,
            }),
        ),
        Effect.map((result) => ({ url: result.stdout.trim() })),
      );

    const checkout = (
      key: string,
      remote: Git.Remote,
      tree: Tree,
    ): Git.Checkout => ({ key, remote, ...tree });

    return {
      checkout: ({ key, remote, ref, fresh }) =>
        Effect.gen(function* () {
          const tree = yield* worktree("ensure", key, [
            ...(ref !== undefined ? ["--ref", ref] : []),
            ...(fresh === true ? ["--fresh"] : []),
          ]);
          if (tree === null) {
            return yield* Effect.fail(
              new Git.GitError({
                command: `${SCRIPT} ensure ${key}`,
                exitCode: 0,
                stderr: "the worktree script printed no tree",
              }),
            );
          }
          return checkout(key, remote, tree);
        }),
      get: (key) =>
        Effect.gen(function* () {
          const tree = yield* worktree("get", key, []);
          if (tree === null) return Option.none();
          return Option.some(checkout(key, yield* originRemote, tree));
        }).pipe(Effect.option, Effect.map(Option.flatten)),
      release: (key) => worktree("drop", key, []).pipe(Effect.asVoid),
    } satisfies Git.CheckoutsService;
  }),
);
