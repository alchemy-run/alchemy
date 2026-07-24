/**
 * WorkspacesWorktree against a LOCAL origin (no network): a seeded
 * bare repo stands in for GitHub; the layer clones it once centrally
 * and derives one worktree per key. Asserts the contract's laws —
 * idempotence by key, isolation between keys, `fresh` re-derivation,
 * and idempotent release.
 */
import * as Git from "@/Git/index.ts";
import { PlatformServices } from "@/Util/PlatformServices.ts";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { ChildProcess } from "effect/unstable/process";

/** No helper answers for a file:// origin — anonymous access. */
const NoCredentials = Layer.succeed(Git.Credentials, {
  for: () => Effect.succeedNone,
});

const git = (args: ReadonlyArray<string>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* ChildProcess.make("git", args);
      const [exitCode, stderr] = yield* Effect.all(
        [
          handle.exitCode,
          Stream.mkString(Stream.decodeText(handle.stderr)),
          Stream.runDrain(handle.stdout),
        ] as const,
        { concurrency: 3 },
      );
      if (exitCode !== 0) {
        return yield* Effect.die(
          new Error(`git ${args.join(" ")} exited ${exitCode}: ${stderr}`),
        );
      }
    }),
  );

/** A bare origin seeded with one commit on `main`. */
const seedOrigin = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const base = yield* fs.makeTempDirectory({ prefix: "alchemy-git-test-" });
  const origin = path.join(base, "origin.git");
  const seed = path.join(base, "seed");

  yield* git(["init", "--bare", "--initial-branch=main", origin]);
  yield* git(["init", "--initial-branch=main", seed]);
  yield* fs.writeFileString(path.join(seed, "README.md"), "# seeded\n");
  const cfg = ["-C", seed, "-c", "user.name=test", "-c", "user.email=t@t.t"];
  yield* git([...cfg.slice(0, 2), "add", "-A"]);
  yield* git([...cfg, "commit", "-m", "seed"]);
  yield* git([...cfg.slice(0, 2), "push", origin, "main"]);

  return { base, remote: { url: origin } satisfies Git.Remote };
});

describe("Git.WorkspacesWorktree", () => {
  it.effect(
    "checkout is idempotent by key, isolated across keys, fresh re-derives, release drops",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { base, remote } = yield* seedOrigin;

        const program = Effect.gen(function* () {
          const workspaces = yield* Git.Workspaces;

          // checkout: the tree exists, on its own branch, seeded
          const one = yield* workspaces.checkout({ key: "issue/1", remote });
          expect(one.branch).toBe("ws/issue-1");
          expect(one.path).toBe(path.join("trees", "issue-1"));
          expect(
            yield* fs.readFileString(path.join(one.root, "README.md")),
          ).toContain("seeded");

          // idempotence: the same key is the same tree
          const again = yield* workspaces.checkout({ key: "issue/1", remote });
          expect(again.root).toBe(one.root);

          // addressability: get() answers for acquired keys only
          expect(Option.isSome(yield* workspaces.get("issue/1"))).toBe(true);
          expect(Option.isNone(yield* workspaces.get("issue/2"))).toBe(true);

          // isolation: a second key is a second tree, coexisting
          const two = yield* workspaces.checkout({ key: "issue/2", remote });
          expect(two.root).not.toBe(one.root);

          // fresh: local dirt is discarded, the tree re-derives
          yield* fs.writeFileString(path.join(one.root, "dirt.txt"), "x");
          const clean = yield* workspaces.checkout({
            key: "issue/1",
            remote,
            fresh: true,
          });
          expect(clean.root).toBe(one.root);
          expect(yield* fs.exists(path.join(clean.root, "dirt.txt"))).toBe(
            false,
          );

          // release: the tree is gone; releasing again is a no-op
          yield* workspaces.release("issue/1");
          expect(yield* fs.exists(one.root)).toBe(false);
          yield* workspaces.release("issue/1");
          expect(yield* fs.exists(two.root)).toBe(true);
        });

        yield* program.pipe(
          Effect.provide(
            Git.WorkspacesWorktree({
              root: path.join(base, "workspaces"),
            }).pipe(
              Layer.provide(NoCredentials),
              Layer.provide(PlatformServices),
            ),
          ),
          Effect.ensuring(
            fs.remove(base, { recursive: true }).pipe(Effect.ignore),
          ),
        );
      }).pipe(Effect.provide(PlatformServices)),
    { timeout: 60_000 },
  );
});
