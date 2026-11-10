/**
 * The stage test runs deploy to, as alchemy-test chooses it: `test_$USER`,
 * plus the linked git worktree's name so two worktrees running the same suite
 * never share deployments. An explicit ALCHEMY_TEST_STAGE wins.
 *
 * Scripts run under Node's type stripping, which cannot load alchemy's CLI
 * modules, so this mirrors `@alchemy.run/test/WorktreeStage` rather than
 * importing it.
 */
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

export const defaultTestStage = Effect.fn(function* () {
  const explicit = yield* Config.String("ALCHEMY_TEST_STAGE").pipe(Config.option);
  if (Option.isSome(explicit) && explicit.value !== "") return explicit.value;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const user = yield* Config.String("USER").pipe(Config.withDefault("unknown"));
  const base = `test_${user.replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "") || "unknown"}`;
  // A linked worktree's `.git` is a file: `gitdir: <common>/.git/worktrees/<name>`.
  const dotGit = path.resolve(import.meta.dirname, "..", ".git");
  const info = yield* fs.stat(dotGit).pipe(Effect.option);
  if (Option.isNone(info) || info.value.type !== "File") return base;
  const gitdir = /^gitdir:\s*(.+)$/m.exec(yield* fs.readFileString(dotGit))?.[1]?.trim();
  const parts = gitdir?.split(/[\\/]+/).filter(Boolean) ?? [];
  const worktree = parts.at(-2) === "worktrees" ? parts.at(-1) : undefined;
  const safe = worktree
    ?.toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return safe ? `${base}_${safe}` : base;
});
