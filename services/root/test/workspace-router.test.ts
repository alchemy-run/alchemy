/**
 * `WorkspaceRouter`'s contract (sandbox/WorkspaceRouter.ts): every
 * sandbox call of a thread-family session resolves to a WORKSPACE —
 * the session's default (`SessionTree.defaultWorkspace`) or an
 * explicit `@<name>/…` — and runs against that workspace's machine
 * (the `AI.Thread` override) below its tree; a session with no
 * resolvable workspace gets a typed error, NEVER a machine root —
 * which is how an engineer once ran `gh pr checkout` in the
 * developer's own checkout. Standalone (repo-keyed) sessions converge
 * their implicit tree on first touch, as before.
 */
import * as AI from "alchemy/AI";
import * as Git from "alchemy/Git";
import * as PersistentRef from "alchemy/PersistentRef";
import { expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { SessionRepo } from "../src/github/SessionRepo.ts";
import { defaultWorkspace } from "../src/sandbox/SessionTree.ts";
import { WorkspaceRouter } from "../src/sandbox/WorkspaceRouter.ts";
import { workspaceKey } from "../src/sandbox/Keys.ts";

const ok = (stdout = ""): AI.SandboxExecResult => ({
  success: true,
  exitCode: 0,
  stdout,
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
  durationMs: 0,
});

/** The raw machines: records each exec's cwd AND which machine (the
 *  ambient `Thread.key`) it landed on. */
const machines = () => {
  const calls: Array<{ machine?: string; cwd?: string }> = [];
  const record = (options?: { cwd?: string }) =>
    Effect.gen(function* () {
      const thread = Option.getOrUndefined(
        yield* Effect.serviceOption(AI.Thread),
      );
      calls.push({
        ...(thread === undefined ? {} : { machine: thread.key }),
        ...(options?.cwd === undefined ? {} : { cwd: options.cwd }),
      });
    });
  const raw = AI.Sandbox.of({
    exec: (_command, _args, options) =>
      record(
        options?.cwd === undefined ? undefined : { cwd: options.cwd },
      ).pipe(Effect.as(ok())),
    readFile: (path) => record({ cwd: path }).pipe(Effect.as("")),
    writeFile: () => Effect.void,
    deleteFile: () => Effect.void,
    mkdir: () => Effect.void,
    listFiles: () => Effect.succeed([]),
    exists: () => Effect.succeed(true),
  });
  return { raw, calls };
};

/** Git over the machines: the thread's workspaces exist by KEY, their
 *  trees at dev-style paths (the workspaces root is the sandbox root). */
const trees = (existing: ReadonlyArray<string>) =>
  Layer.succeed(Git.Checkouts, {
    checkout: () => Effect.die("no session of this test derives a tree"),
    get: (key) =>
      Effect.succeed<Option.Option<Git.Checkout>>(
        existing.includes(key)
          ? Option.some({
              key,
              remote: { url: "https://example.invalid/repo.git" },
              root: `/host/.alchemy/workspaces/${key.replaceAll(/[^a-zA-Z0-9._-]+/g, "-")}`,
              path: key.replaceAll(/[^a-zA-Z0-9._-]+/g, "-"),
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
  WorkspaceRouter.pipe(
    Layer.provide(
      Layer.mergeAll(Layer.succeed(AI.Sandbox, raw), trees(existing), noRepo),
    ),
  );

const PR5 = workspaceKey("t-1", "pr-5");
const PR6 = workspaceKey("t-1", "pr-6");

test("calls land on the workspace's machine, below its tree — default and @name alike", async () => {
  const { raw, calls } = machines();
  await Effect.runPromise(
    Effect.gen(function* () {
      const sandbox = yield* AI.Sandbox;
      // engineer A: default = the thread's pr-5 workspace
      const a = frame("t-1::e-a");
      yield* a(PersistentRef.set(defaultWorkspace, "pr-5"));
      yield* a(sandbox.exec("git status"));
      yield* a(sandbox.exec("pnpm test", undefined, { cwd: "packages/x" }));
      // …and it reaches a SIBLING workspace explicitly
      yield* a(sandbox.readFile("@pr-6/README.md"));
      // engineer B: its own default, not A's
      const b = frame("t-1::e-b");
      yield* b(PersistentRef.set(defaultWorkspace, "pr-6"));
      yield* b(sandbox.exec("git status"));
      // the manager (no default): explicit @name only
      yield* frame("t-1")(
        sandbox.exec("git log", undefined, { cwd: "@pr-5" }),
      );
    }).pipe(Effect.provide(layer([PR5, PR6], raw))),
  );
  expect(calls).toEqual([
    { machine: PR5, cwd: "t-1-ws-pr-5" },
    { machine: PR5, cwd: "t-1-ws-pr-5/packages/x" },
    { machine: PR6, cwd: "t-1-ws-pr-6/README.md" },
    { machine: PR6, cwd: "t-1-ws-pr-6" },
    { machine: PR5, cwd: "t-1-ws-pr-5" },
  ]);
});

test("no default and no @name fails with guidance — NEVER a machine root", async () => {
  const { raw, calls } = machines();
  const outcome = await Effect.runPromise(
    Effect.gen(function* () {
      const sandbox = yield* AI.Sandbox;
      return yield* frame("t-1::e-lost")(sandbox.exec("git status")).pipe(
        Effect.flip,
      );
    }).pipe(Effect.provide(layer([PR5], raw))),
  );
  expect(String(outcome)).toContain("no workspace");
  expect(String(outcome)).toContain("@<name>");
  expect(calls).toEqual([]);
});

test("an unknown workspace name fails with the reason — never falls through", async () => {
  const { raw, calls } = machines();
  const outcome = await Effect.runPromise(
    Effect.gen(function* () {
      const sandbox = yield* AI.Sandbox;
      const a = frame("t-1::e-a");
      yield* a(PersistentRef.set(defaultWorkspace, "pr-9"));
      return yield* a(sandbox.exec("git status")).pipe(Effect.flip);
    }).pipe(Effect.provide(layer([PR5], raw))),
  );
  expect(String(outcome)).toContain("pr-9");
  expect(String(outcome)).toContain("no workspace named");
  expect(calls).toEqual([]);
});

test("a workspace session works in its OWN tree", async () => {
  const { raw, calls } = machines();
  await Effect.runPromise(
    Effect.gen(function* () {
      const sandbox = yield* AI.Sandbox;
      yield* frame(PR5)(sandbox.exec("git status"));
    }).pipe(Effect.provide(layer([PR5], raw))),
  );
  expect(calls).toEqual([{ machine: PR5, cwd: "t-1-ws-pr-5" }]);
});

test("a standalone session converges its implicit tree and passes through", async () => {
  const { raw, calls } = machines();
  let checkedOut = 0;
  const standaloneTrees = Layer.succeed(Git.Checkouts, {
    checkout: (options) =>
      Effect.sync(() => {
        checkedOut++;
        return {
          key: options.key,
          remote: options.remote,
          root: "/workspace",
          path: ".",
          branch: "main",
        };
      }),
    get: () => Effect.succeed(Option.none()),
    release: () => Effect.void,
  });
  const repo = Layer.succeed(SessionRepo, {
    resolve: (key: string) =>
      Effect.succeed(
        key.includes("/")
          ? {
              repo: "acme/widgets",
              remote: { url: "https://example.invalid/widgets.git" },
              ref: undefined,
              fresh: false,
              pull: undefined,
            }
          : undefined,
      ),
  } as never);
  await Effect.runPromise(
    Effect.gen(function* () {
      const sandbox = yield* AI.Sandbox;
      const s = frame("acme/widgets/main");
      yield* s(sandbox.exec("git status"));
      yield* s(sandbox.exec("git log"));
    }).pipe(
      Effect.provide(
        WorkspaceRouter.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(AI.Sandbox, raw),
              standaloneTrees,
              repo,
            ),
          ),
        ),
      ),
    ),
  );
  // one converge, both calls at the machine root (its disk IS the tree),
  // no Thread override (its own machine)
  expect(checkedOut).toBe(1);
  expect(calls).toEqual([
    { machine: "acme/widgets/main" },
    { machine: "acme/widgets/main" },
  ]);
});
