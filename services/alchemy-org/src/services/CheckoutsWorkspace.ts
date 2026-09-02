import * as AI from "alchemy/AI";
import * as Git from "alchemy/Git";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

/**
 * `Git.Checkouts` over a sandbox that IS the developer's live working
 * tree — the dev-mode pairing for `AI.SandboxHttp` against
 * `AI.serveSandbox` (see ../SandboxSession.ts).
 *
 * READ-ONLY on git state, by design: it never fetches, switches, or
 * resets. The tree is whatever the developer has checked out, with
 * whatever is uncommitted in it, and every session adopts it as-is
 * (`ref`/`fresh` are ignored — there is no "re-derive" of a human's
 * working copy). `CheckoutsSandbox`'s converge-onto-branch dance
 * (`checkout --force -B`, `reset --hard`) is exactly what must NEVER
 * run against a real workspace, so this is a separate Layer rather
 * than a flag on that one.
 */
export const CheckoutsWorkspace = Layer.effect(
  Git.Checkouts,
  Effect.gen(function* () {
    const sandbox = yield* AI.Sandbox;

    /** One read-only command in the tree root; stdout, trimmed. */
    const read = (command: string, args: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        const result = yield* sandbox
          .exec(command, args, { timeout: 30_000 })
          .pipe(
            Effect.mapError(
              (error) =>
                new Git.GitError({
                  command: [command, ...args].join(" "),
                  exitCode: -1,
                  stderr: String(error),
                }),
            ),
          );
        if (!result.success) {
          return yield* Effect.fail(
            new Git.GitError({
              command: [command, ...args].join(" "),
              exitCode: result.exitCode,
              stderr: result.stderr,
            }),
          );
        }
        return result.stdout.trim();
      });

    /** Where the tree is and what it has checked out — observed, never
     *  cached: the developer switches branches under us at will. */
    const observe = (key: string, remote: Git.Remote) =>
      Effect.gen(function* () {
        const root = yield* read("pwd", []);
        const branch = yield* read("git", [
          "rev-parse",
          "--abbrev-ref",
          "HEAD",
        ]);
        return {
          key,
          root,
          path: ".",
          branch,
          remote,
        } satisfies Git.Checkout;
      });

    /** Whatever `origin` the tree tracks — the remote a `get` reports
     *  when nobody told us one. */
    const originRemote: Effect.Effect<Git.Remote, Git.GitError> = read("git", [
      "remote",
      "get-url",
      "origin",
    ]).pipe(Effect.map((url) => ({ url })));

    return {
      checkout: ({ key, remote }) => observe(key, remote),
      get: (key) =>
        originRemote.pipe(
          Effect.flatMap((remote) => observe(key, remote)),
          Effect.option,
        ),
      release: () => Effect.void,
    } satisfies Git.CheckoutsService;
  }),
);
