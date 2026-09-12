/**
 * The dev-mode `Git.Checkouts` physics (`sandbox/CheckoutsWorktree.ts`
 * over `scripts/worktree.ts`) run against THIS repository — the real
 * fixture: husky's `core.hooksPath` hooks fire during `git worktree
 * add`, the real `scripts/bootstrap-distilled.mjs` links distilled,
 * and the trees land under the real `.alchemy/worktrees/`.
 *
 * What must hold: a session's tree is a LINKED worktree — `git
 * worktree add`, never a clone — and its distilled submodule is a
 * linked worktree of the shared `.git/modules/distilled`, so a
 * checkout carries NO object store of its own. `release` removes the
 * tree, both worktree registrations, and the synthetic branch, and
 * the trashed files are reaped.
 *
 * The second test pins the PR-1356 regression: a checkout of a pull
 * head that PREDATES `scripts/bootstrap-distilled.mjs` (and the
 * distilled submodule) must not fail the `worktree add` — the
 * post-checkout hook resolves the script beside ITSELF and the
 * bootstrap skips a tree with nothing to bootstrap. It fetches
 * `pull/1356/head` from origin, so it needs network.
 *
 * Keys are `test-cw-*`: distinct from any real session's, torn down
 * by the tests themselves (idempotent releases).
 *
 *   bun test test/checkouts-worktree.test.ts
 */
import { BunServices } from "@effect/platform-bun";
import { expect, test } from "bun:test";
import * as AI from "alchemy/AI";
import { SandboxLocal } from "alchemy/AI";
import * as Git from "alchemy/Git";
import { fixed as workspace } from "alchemy/Workspace";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import { resolve } from "node:path";
import { CheckoutsWorktree } from "../src/sandbox/CheckoutsWorktree.ts";

/** The repository under test IS this repository. */
const REPO = resolve(import.meta.dirname, "..", "..", "..");
/** The pull request whose pre-bootstrap-era head broke worktree adds. */
const OLD_PR_REF = "pull/1356/head";

/** The dev session's physics: a sandbox rooted at the developer's
 *  workspace — this repo — with `CheckoutsWorktree` over it. The same
 *  sandbox doubles as the tests' out-of-band verification rig. */
const Box = SandboxLocal.pipe(Layer.provide(workspace(REPO)));
const Checkouts = CheckoutsWorktree.pipe(Layer.provide(Box));

const run = <A, E>(program: Effect.Effect<A, E, any>): Promise<A> =>
  Effect.runPromise(
    program.pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mergeAll(Checkouts, Box).pipe(Layer.provide(BunServices.layer)),
          BunServices.layer,
        ),
      ),
      Effect.scoped,
    ) as Effect.Effect<A, E>,
  );

const sh = (command: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const sandbox = yield* AI.Sandbox;
    const result = yield* sandbox.exec(command, args, { timeout: 60_000 });
    if (!result.success) {
      return yield* Effect.fail(
        `${command} ${args.join(" ")} (exit ${result.exitCode}):\n${result.stderr}`,
      );
    }
    return result.stdout.trim();
  });

/** `a` and `b` are the same directory (realpath — /tmp vs /private/tmp). */
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
    const path = yield* Path.Path;
    const trash = fs.readDirectory(path.join(REPO, ".alchemy", "worktrees")).pipe(
      Effect.orDie,
      Effect.map((entries) =>
        entries.filter((entry) => entry.startsWith(`.trash-${key}-`)),
      ),
    );
    // the reaper unlinks the 13k-file checkout PLUS the seeded
    // node_modules clones (hundreds of thousands of files) — minutes
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

test(
  "a checkout of this repo is a LINKED worktree — distilled included — sharing one object store; release removes every trace",
  () =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const checkouts = yield* Git.Checkouts;
        const key = "test-cw-head";
        // the developer's own repository: worktree registrations and the
        // shared distilled store live in ITS common dirs
        const common = yield* sh("git", [
          "rev-parse",
          "--path-format=absolute",
          "--git-common-dir",
        ]);
        const distilledCommon = path.join(common, "modules", "distilled");

        yield* Effect.gen(function* () {
          // no ref: based on this workspace's HEAD — no network
          const co = yield* checkouts.checkout({
            key,
            remote: { url: "https://github.com/alchemy-run/alchemy-effect.git" },
          });
          expect(co.path).toBe(`.alchemy/worktrees/${key}`);
          expect(co.branch).toBe(`ws/${key}`);
          yield* samePath(co.root, path.join(REPO, ".alchemy", "worktrees", key));

          // LINKED, not cloned: `.git` is a gitfile into this repository —
          // the tree owns no repository of its own
          expect(
            (yield* fs.stat(path.join(co.root, ".git")).pipe(Effect.orDie))
              .type,
          ).toBe("File");
          yield* samePath(
            yield* sh("git", [
              "-C",
              co.root,
              "rev-parse",
              "--path-format=absolute",
              "--git-common-dir",
            ]),
            common,
          );

          // distilled: a linked worktree of the SHARED
          // `.git/modules/distilled`, at the commit the tree pins
          const dist = path.join(co.root, "submodules", "distilled");
          expect(
            (yield* fs.stat(path.join(dist, ".git")).pipe(Effect.orDie)).type,
          ).toBe("File");
          const pin = yield* sh("git", [
            "-C",
            co.root,
            "rev-parse",
            "HEAD:submodules/distilled",
          ]);
          expect(yield* sh("git", ["-C", dist, "rev-parse", "HEAD"])).toBe(pin);
          yield* samePath(
            yield* sh("git", [
              "-C",
              dist,
              "rev-parse",
              "--path-format=absolute",
              "--git-common-dir",
            ]),
            distilledCommon,
          );

          // the efficiency claim, literally: not one git pack file under
          // the tree — every object lives once, in this repository's
          // store (node_modules is pruned: it is seeded, not git's)
          expect(
            yield* sh("find", [
              co.root,
              "-name",
              "node_modules",
              "-prune",
              "-o",
              "-name",
              "*.pack",
              "-print",
            ]),
          ).toBe("");

          // node_modules is SEEDED from the workspace (APFS clone):
          // pnpm's virtual store and the workspace-package links are
          // already in place before any install runs
          expect(
            yield* fs.exists(
              path.join(co.root, "node_modules", ".pnpm", "lock.yaml"),
            ),
          ).toBe(true);
          expect(
            yield* fs.exists(
              path.join(
                co.root,
                "node_modules",
                "alchemy",
                "package.json",
              ),
            ),
          ).toBe(true);
          expect(
            yield* fs.exists(
              path.join(co.root, "packages", "alchemy", "node_modules"),
            ),
          ).toBe(true);

          // idempotent by key: the same tree, not a second one
          const again = yield* checkouts.checkout({
            key,
            remote: { url: "https://github.com/alchemy-run/alchemy-effect.git" },
          });
          expect(again.root).toBe(co.root);
          expect(Option.isSome(yield* checkouts.get(key))).toBe(true);
        }).pipe(Effect.ensuring(checkouts.release(key).pipe(Effect.ignore)));

        // teardown: tree gone, registrations pruned (repo AND distilled),
        // synthetic branch dropped, trash reaped
        const treeDir = path.join(REPO, ".alchemy", "worktrees", key);
        expect(yield* fs.exists(treeDir)).toBe(false);
        expect(
          yield* sh("git", ["worktree", "list", "--porcelain"]),
        ).not.toContain(`.alchemy/worktrees/${key}`);
        expect(
          yield* sh("git", [
            "-C",
            distilledCommon,
            "worktree",
            "list",
            "--porcelain",
          ]),
        ).not.toContain(`.alchemy/worktrees/${key}`);
        expect(yield* sh("git", ["branch", "--list", `ws/${key}`])).toBe("");
        yield* reaped(key);
        expect(Option.isNone(yield* checkouts.get(key))).toBe(true);
      }),
    ),
  420_000,
);

test(
  "a pull head that PREDATES the bootstrap script checks out cleanly — the post-checkout hook skips what is not there (network)",
  () =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const checkouts = yield* Git.Checkouts;
        const key = "test-cw-pr-1356";

        yield* Effect.gen(function* () {
          // the shape of the original failure: `git worktree add` for a
          // ref with no `scripts/bootstrap-distilled.mjs` and no distilled
          // pin, with this repository's hooks live
          const co = yield* checkouts.checkout({
            key,
            remote: { url: "https://github.com/alchemy-run/alchemy-effect.git" },
            ref: OLD_PR_REF,
          });
          // a pull head is not a branch — the tree gets the synthetic one
          expect(co.branch).toBe(`ws/${key}`);
          expect(
            yield* fs.exists(
              path.join(co.root, "scripts", "bootstrap-distilled.mjs"),
            ),
          ).toBe(false);
          // no distilled at that commit — and none invented
          expect(yield* fs.exists(path.join(co.root, "submodules"))).toBe(
            false,
          );
        }).pipe(Effect.ensuring(checkouts.release(key).pipe(Effect.ignore)));

        expect(
          yield* fs.exists(path.join(REPO, ".alchemy", "worktrees", key)),
        ).toBe(false);
        expect(yield* sh("git", ["branch", "--list", `ws/${key}`])).toBe("");
        yield* reaped(key);
        expect(Option.isNone(yield* checkouts.get(key))).toBe(true);
      }),
    ),
  420_000,
);
