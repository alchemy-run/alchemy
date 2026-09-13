/**
 * Dev-mode WORKSPACES against THIS repository — the real fixture: the
 * repo's own hooks fire during `git worktree add`, the real
 * `scripts/bootstrap-distilled.mjs` links distilled, trees land under
 * the real `.alchemy/workspaces/`.
 *
 * Three layers are pinned:
 *
 * 1. `makeWorkspaceHost` (sandbox/WorkspaceHost.ts) — the provisioning
 *    physics: a workspace is a LINKED worktree (one object store),
 *    distilled a linked worktree of the shared `.git/modules/distilled`,
 *    node_modules an APFS clone; drop removes every trace.
 * 2. The served dev stack — `AI.serveSandbox` rooted at the WORKSPACES
 *    directory with the host verbs extended in (what
 *    scripts/sandbox-dev.ts runs), `CheckoutsWorkspace` + `SandboxDev`
 *    + `WorkspaceRouter` as the Worker composes them: an engineer's
 *    calls land inside its workspace, `@name` reaches siblings, and
 *    the developer's checkout is STRUCTURALLY out of reach (the
 *    incident regression).
 * 3. The pre-bootstrap-era ref (`pull/1356/head`, network): a tree
 *    that predates the distilled submodule provisions cleanly.
 *
 * Keys are `test-ws-*`: distinct from any real thread's, torn down by
 * the tests themselves (idempotent releases).
 *
 *   bun test test/workspaces.test.ts
 */
import { BunServices } from "@effect/platform-bun";
import { expect, test } from "bun:test";
import * as AI from "alchemy/AI";
import * as Git from "alchemy/Git";
import * as PersistentRef from "alchemy/PersistentRef";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import { resolve } from "node:path";
import { CheckoutsWorkspace } from "../src/sandbox/CheckoutsWorkspace.ts";
import { SandboxDev } from "../src/sandbox/SandboxDev.ts";
import { defaultWorkspace } from "../src/sandbox/SessionTree.ts";
import {
  makeWorkspaceHost,
  WORKSPACES_DIR,
  workspaceDir,
} from "../src/sandbox/WorkspaceHost.ts";
import { WorkspaceRouter } from "../src/sandbox/WorkspaceRouter.ts";
import { SessionRepo } from "../src/github/SessionRepo.ts";
import { workspaceKey } from "../src/thread/Terms.ts";

/** The repository under test IS this repository. */
const REPO = resolve(import.meta.dirname, "..", "..", "..");
const WORKSPACES = resolve(REPO, WORKSPACES_DIR);
/** The pull request whose pre-bootstrap-era head broke worktree adds. */
const OLD_PR_REF = "pull/1356/head";
/** A fixed loopback port for the forked dev server — test-only. */
const PORT = 43117;

const run = <A, E>(program: Effect.Effect<A, E, any>): Promise<A> =>
  Effect.runPromise(
    program.pipe(
      Effect.provide(BunServices.layer),
      Effect.scoped,
    ) as Effect.Effect<A, E>,
  );

const host = Effect.cached(
  makeWorkspaceHost(REPO).pipe(Effect.provide(BunServices.layer)),
);

/** `a` and `b` are the same directory (realpath — /tmp vs /private). */
const samePath = (a: string, b: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    expect(yield* fs.realPath(a).pipe(Effect.orDie)).toBe(
      yield* fs.realPath(b).pipe(Effect.orDie),
    );
  });

/** Wait for the detached trash reaper to delete this key's remains. */
const reaped = (key: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const trash = fs.readDirectory(WORKSPACES).pipe(
      Effect.orDie,
      Effect.map((entries) =>
        entries.filter((entry) =>
          entry.startsWith(`.trash-${workspaceDir(key)}-`),
        ),
      ),
    );
    // the reaper unlinks the checkout PLUS the seeded node_modules
    // clones (hundreds of thousands of files) — minutes
    expect(
      yield* trash.pipe(
        Effect.repeat({
          schedule: Schedule.spaced("500 millis"),
          until: (left) => left.length === 0,
          times: 480,
        }),
      ),
    ).toEqual([]);
  });

const sh = (command: string, args: ReadonlyArray<string>, cwd: string) =>
  Effect.gen(function* () {
    const proc = Bun.spawnSync([command, ...args], { cwd });
    if (proc.exitCode !== 0) {
      return yield* Effect.fail(
        `${command} ${args.join(" ")} (exit ${proc.exitCode}): ${proc.stderr.toString()}`,
      );
    }
    return proc.stdout.toString().trim();
  });

test(
  "a workspace is a LINKED worktree — distilled included, node_modules seeded — and drop removes every trace",
  () =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const verbs = yield* yield* host;
        const key = workspaceKey("test-ws", "head");
        const dir = workspaceDir(key);

        const tree = yield* verbs.workspaceEnsure(key);
        yield* Effect.addFinalizer(() =>
          verbs.workspaceDrop(key).pipe(Effect.ignore),
        );
        expect(tree.path).toBe(dir);
        yield* samePath(tree.root, path.join(WORKSPACES, dir));

        // LINKED, not cloned: `.git` is a gitfile into this repository
        expect(
          (yield* fs.stat(path.join(tree.root, ".git")).pipe(Effect.orDie))
            .type,
        ).toBe("File");
        const common = yield* sh(
          "git",
          ["rev-parse", "--path-format=absolute", "--git-common-dir"],
          REPO,
        );
        yield* samePath(
          yield* sh(
            "git",
            ["rev-parse", "--path-format=absolute", "--git-common-dir"],
            tree.root,
          ),
          common,
        );

        // distilled: a linked worktree of the SHARED module repository,
        // at the commit the tree pins
        const dist = path.join(tree.root, "submodules", "distilled");
        expect(
          (yield* fs.stat(path.join(dist, ".git")).pipe(Effect.orDie)).type,
        ).toBe("File");
        const pin = yield* sh(
          "git",
          ["rev-parse", "HEAD:submodules/distilled"],
          tree.root,
        );
        expect(yield* sh("git", ["rev-parse", "HEAD"], dist)).toBe(pin);

        // the efficiency claim: not one git pack file under the tree
        // (node_modules pruned — seeded, not git's)
        expect(
          yield* sh(
            "find",
            [
              tree.root,
              "-name",
              "node_modules",
              "-prune",
              "-o",
              "-name",
              "*.pack",
              "-print",
            ],
            REPO,
          ),
        ).toBe("");

        // node_modules SEEDED (APFS clone of the developer's)
        expect(
          yield* fs.exists(
            path.join(tree.root, "node_modules", ".pnpm", "lock.yaml"),
          ),
        ).toBe(true);

        // idempotent by key; get answers the same tree
        expect((yield* verbs.workspaceEnsure(key)).root).toBe(tree.root);
        expect((yield* verbs.workspaceGet(key))?.root).toBe(tree.root);

        // drop: tree gone, registrations pruned, branch dropped, reaped
        yield* verbs.workspaceDrop(key);
        expect(yield* fs.exists(tree.root)).toBe(false);
        expect(
          yield* sh("git", ["worktree", "list", "--porcelain"], REPO),
        ).not.toContain(`${WORKSPACES_DIR}/${dir}`);
        expect(
          yield* sh("git", ["branch", "--list", `ws/${dir}`], REPO),
        ).toBe("");
        yield* reaped(key);
        expect(yield* verbs.workspaceGet(key)).toBe(null);
      }),
    ),
  420_000,
);

test(
  "the served dev stack routes an engineer into its workspace and NEVER the developer's checkout",
  () =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const verbs = yield* yield* host;
        const key = workspaceKey("test-ws", "routed");
        const dir = workspaceDir(key);

        // the dev server, exactly as scripts/sandbox-dev.ts runs it —
        // rooted at the WORKSPACES directory, verbs extended in
        const server = yield* Effect.forkScoped(
          AI.serveSandbox({
            root: WORKSPACES,
            port: PORT,
            strictPort: true,
            extend: { ...verbs },
          }),
        );
        yield* Effect.addFinalizer(() => Fiber.interrupt(server));
        const url = Effect.succeed<string | undefined>(
          `http://localhost:${PORT}`,
        );

        // the Worker's dev composition (SandboxSession.machine)
        const noRepo = Layer.succeed(SessionRepo, {
          resolve: () => Effect.succeed(undefined),
        });
        const sandboxLayer = SandboxDev(url);
        const git = CheckoutsWorkspace(url);
        const stack = Layer.mergeAll(
          WorkspaceRouter.pipe(
            Layer.provide(Layer.mergeAll(sandboxLayer, git, noRepo)),
          ),
          git,
        );

        yield* Effect.gen(function* () {
          const checkouts = yield* Git.Checkouts;
          const sandbox = yield* AI.Sandbox;

          // wait for the server, then provision over RPC (as the
          // Workspace agent would)
          const tree = yield* checkouts
            .checkout({ key, remote: { url: "" } })
            .pipe(
              Effect.retry({
                schedule: Schedule.exponential("250 millis"),
                times: 8,
              }),
            );
          yield* Effect.addFinalizer(() =>
            checkouts.release(key).pipe(Effect.ignore),
          );
          expect(tree.path).toBe(dir);

          // an engineer session whose DEFAULT workspace this is
          const store = PersistentRef.makeMemoryStore();
          const engineer = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
            effect.pipe(
              Effect.provideService(AI.Thread, {
                key: "test-ws::e-1",
              } as never),
              Effect.provideService(PersistentRef.Store, store),
            );
          yield* engineer(PersistentRef.set(defaultWorkspace, "routed"));

          // its calls land INSIDE the workspace…
          const branch = yield* engineer(
            sandbox.exec("git", ["rev-parse", "--abbrev-ref", "HEAD"]),
          );
          expect(branch.success).toBe(true);
          expect(branch.stdout.trim()).toBe(`ws/${dir}`);
          const pkg = yield* engineer(sandbox.readFile("package.json"));
          expect(pkg).toContain('"name"');
          // …reach a sibling workspace explicitly (its own, by name)…
          expect(
            yield* engineer(sandbox.exists("@routed/package.json")),
          ).toBe(true);
          // …and CANNOT escape: the served root IS the workspaces dir
          const escaped = yield* engineer(
            sandbox.readFile("@routed/../../package.json"),
          ).pipe(Effect.flip);
          expect(String(escaped)).toContain("escapes the workspace");
          // an unknown workspace fails with guidance, not a fallback
          const unknown = yield* engineer(
            sandbox.readFile("@nope/README.md"),
          ).pipe(Effect.flip);
          expect(String(unknown)).toContain("no workspace named 'nope'");
          // a session with NO default fails closed
          const bare = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
            effect.pipe(
              Effect.provideService(AI.Thread, {
                key: "test-ws::e-2",
              } as never),
              Effect.provideService(
                PersistentRef.Store,
                PersistentRef.makeMemoryStore(),
              ),
            );
          const lost = yield* bare(sandbox.exec("git", ["status"])).pipe(
            Effect.flip,
          );
          expect(String(lost)).toContain("no workspace");

          yield* checkouts.release(key);
          expect(Option.isNone(yield* checkouts.get(key))).toBe(true);
        }).pipe(Effect.provide(stack));

        yield* reaped(key);
        expect(
          yield* fs.exists(resolve(WORKSPACES, dir)),
        ).toBe(false);
      }),
    ),
  420_000,
);

test(
  "a ref that PREDATES the bootstrap script provisions cleanly (network)",
  () =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const verbs = yield* yield* host;
        const key = workspaceKey("test-ws", "pr-1356");

        const tree = yield* verbs.workspaceEnsure(key, { ref: OLD_PR_REF });
        yield* Effect.addFinalizer(() =>
          verbs.workspaceDrop(key).pipe(Effect.ignore),
        );
        expect(
          yield* fs.exists(
            path.join(tree.root, "scripts", "bootstrap-distilled.mjs"),
          ),
        ).toBe(false);
        expect(yield* fs.exists(path.join(tree.root, "submodules"))).toBe(
          false,
        );
        yield* verbs.workspaceDrop(key);
        expect(yield* fs.exists(tree.root)).toBe(false);
        yield* reaped(key);
      }),
    ),
  420_000,
);
