/**
 * `SandboxCheckout`'s rooting contract (sandbox/SandboxCheckout.ts):
 * a session HANDED a tree (`SessionTree.assignedTree` set in its own
 * state — a thread's engineer, given the thread's worktree for the
 * pull request its brief is about) has EVERY call re-rooted at that
 * existing checkout; a session without one derives its tree from its
 * key as before; two engineers of one thread keep their own trees;
 * a handed tree that is gone fails the call with the reason instead
 * of silently working at the machine's root — which is how an
 * engineer once ran `gh pr checkout` in the developer's own checkout.
 */
import * as AI from "alchemy/AI";
import * as Git from "alchemy/Git";
import * as PersistentRef from "alchemy/PersistentRef";
import { expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { SessionRepo } from "../src/github/SessionRepo.ts";
import { SandboxCheckout } from "../src/sandbox/SandboxCheckout.ts";
import { assignedTree } from "../src/sandbox/SessionTree.ts";

const ok = (stdout = ""): AI.SandboxExecResult => ({
  success: true,
  exitCode: 0,
  stdout,
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
  durationMs: 0,
});

/** The raw machine: records where each exec was rooted. */
const machine = () => {
  const cwds: Array<string | undefined> = [];
  const raw = AI.Sandbox.of({
    exec: (_command, _args, options) =>
      Effect.sync(() => {
        cwds.push(options?.cwd);
        return ok();
      }),
    readFile: () => Effect.succeed(""),
    writeFile: () => Effect.void,
    deleteFile: () => Effect.void,
    mkdir: () => Effect.void,
    listFiles: () => Effect.succeed([]),
    exists: () => Effect.succeed(true),
  });
  return { raw, cwds };
};

/** Git over the machine: the thread's worktrees exist by key. */
const trees = (existing: ReadonlyArray<string>) =>
  Layer.succeed(Git.Checkouts, {
    checkout: () => Effect.die("no session of this test derives a tree"),
    get: (key) =>
      Effect.succeed<Option.Option<Git.Checkout>>(
        existing.includes(key)
          ? Option.some({
              key,
              remote: { url: "https://example.invalid/repo.git" },
              root: `/machine/.alchemy/worktrees/${key}`,
              path: `.alchemy/worktrees/${key}`,
              branch: `ws/${key}`,
            })
          : Option.none(),
      ),
    release: () => Effect.void,
  });

/** Thread keys (`t-…`, `t-…::e-…`) derive no tree of their own. */
const noRepo = Layer.succeed(SessionRepo, {
  resolve: () => Effect.succeed(undefined),
});

/** A session frame: its key, and its own state store. */
const frame = (key: string) => {
  const store = PersistentRef.makeMemoryStore();
  return <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(AI.Thread, { key } as never),
      Effect.provideService(PersistentRef.Store, store),
    );
};

const layer = (existing: ReadonlyArray<string>, raw: AI.Sandbox["Service"]) =>
  SandboxCheckout.pipe(
    Layer.provide(
      Layer.mergeAll(Layer.succeed(AI.Sandbox, raw), trees(existing), noRepo),
    ),
  );

test("an engineer handed a tree is rooted in it; one without works at the root", async () => {
  const { raw, cwds } = machine();
  await Effect.runPromise(
    Effect.gen(function* () {
      const sandbox = yield* AI.Sandbox;
      // engineer A: handed the thread's worktree for PR 5
      const a = frame("t-1::e-a");
      yield* a(PersistentRef.set(assignedTree, "t-1--pr-5"));
      yield* a(sandbox.exec("git status"));
      yield* a(sandbox.exec("pnpm test", undefined, { cwd: "packages/x" }));
      // engineer B: handed PR 6's — its own tree, not A's
      const b = frame("t-1::e-b");
      yield* b(PersistentRef.set(assignedTree, "t-1--pr-6"));
      yield* b(sandbox.exec("git status"));
      // an engineer handed nothing: the machine's root, as before
      yield* frame("t-1::e-c")(sandbox.exec("git status"));
    }).pipe(Effect.provide(layer(["t-1--pr-5", "t-1--pr-6"], raw))),
  );
  expect(cwds).toEqual([
    ".alchemy/worktrees/t-1--pr-5",
    ".alchemy/worktrees/t-1--pr-5/packages/x",
    ".alchemy/worktrees/t-1--pr-6",
    undefined,
  ]);
});

test("a handed tree that is gone fails the call with the reason — never the root", async () => {
  const { raw, cwds } = machine();
  const outcome = await Effect.runPromise(
    Effect.gen(function* () {
      const sandbox = yield* AI.Sandbox;
      const a = frame("t-1::e-a");
      yield* a(PersistentRef.set(assignedTree, "t-1--pr-9"));
      return yield* a(sandbox.exec("git status")).pipe(Effect.flip);
    }).pipe(Effect.provide(layer([], raw))),
  );
  expect(outcome).toContain("t-1--pr-9");
  expect(outcome).toContain("no longer exists");
  expect(cwds).toEqual([]);
});
