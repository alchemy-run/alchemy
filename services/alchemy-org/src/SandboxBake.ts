import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";
import { fileURLToPath } from "node:url";

/** Where sessions publish to — the staged repo's origin is re-pointed
 *  here (the staging source is a `file://` path that means nothing
 *  inside the image). */
export const ORG_REMOTE = "https://github.com/alchemy-run/alchemy.git";

/** Bump when the staging layout changes — invalidates stale stages. */
const STAGE_VERSION = "v1";

const MARKER = ".bake-fingerprint";

/**
 * The repo root, derived STATICALLY from this module's location
 * (`services/alchemy-org/src/` → three levels up). Deliberately not
 * `git rev-parse --show-toplevel`: under `alchemy dev`, child-process
 * stdout capture is unreliable in the exec worker (exit codes are
 * fine), so nothing correctness-critical may depend on captured
 * output.
 */
const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url)).replace(
  /\/$/,
  "",
);

export interface StagedBake {
  /** The staged repo directory — feed to `contextInclude.from`. */
  readonly dir: string;
  /** Cheap content identity (HEAD commits) — feed to `fingerprint`. */
  readonly fingerprint: string;
}

class BakeError extends Error {
  override readonly name = "SandboxBakeError";
}

/** Run one shell command for its EFFECT — only the exit code is
 *  trusted (see {@link REPO_ROOT} on why stdout is not). */
const sh = (command: string, cwd?: string) =>
  Effect.gen(function* () {
    const handle = yield* ChildProcess.make(command, [], {
      shell: true,
      ...(cwd !== undefined ? { cwd } : {}),
    });
    const [exitCode, stderr] = yield* Effect.all(
      [handle.exitCode, Stream.mkString(Stream.decodeText(handle.stderr))],
      { concurrency: 2 },
    );
    if (exitCode !== 0) {
      return yield* Effect.fail(
        new BakeError(`${command} (exit ${exitCode}):\n${stderr.trim()}`),
      );
    }
  }).pipe(Effect.scoped);

const q = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/**
 * Resolve a checkout's `.git` to its real git directory — a submodule
 * checkout's `.git` is a FILE containing `gitdir: <path>`.
 */
const resolveGitDir = (checkout: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dotGit = path.join(checkout, ".git");
    const info = yield* fs.stat(dotGit);
    if (info.type === "Directory") return dotGit;
    const pointer = (yield* fs.readFileString(dotGit)).trim();
    const target = pointer.replace(/^gitdir:\s*/, "");
    return path.isAbsolute(target) ? target : path.resolve(checkout, target);
  });

/**
 * The commit a checkout's HEAD points at, read from the FILESYSTEM
 * (HEAD → loose ref → packed-refs) — no git subprocess involved.
 */
const readHead = (checkout: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const gitDir = yield* resolveGitDir(checkout);
    const head = (yield* fs.readFileString(path.join(gitDir, "HEAD"))).trim();
    if (!head.startsWith("ref: ")) return head; // detached
    const ref = head.slice("ref: ".length).trim();
    const loose = yield* fs
      .readFileString(path.join(gitDir, ref))
      .pipe(Effect.option);
    if (loose._tag === "Some") return loose.value.trim();
    const packed = yield* fs
      .readFileString(path.join(gitDir, "packed-refs"))
      .pipe(Effect.orElseSucceed(() => ""));
    for (const line of packed.split("\n")) {
      if (line.endsWith(` ${ref}`)) return line.slice(0, 40);
    }
    return yield* Effect.fail(
      new BakeError(`cannot resolve ${ref} in ${gitDir}`),
    );
  });

/**
 * Stage the LOCAL repository for the sandbox image bake — no network,
 * no GitHub clone: the source of truth is the repo root this deploy
 * runs from.
 *
 * The literal repo cannot ship (`.git` alone is ~100GB of local object
 * store), so the stage is the local repo REDUCED to what the image
 * needs to behave as a worktree of the branch:
 *
 * - the COMMITTED tree of `HEAD` (`git archive` — no gitignored cruft,
 *   no host `node_modules`), plus distilled's committed tree;
 * - a REAL `.git` derived from the local object store: a depth-1 pack
 *   of `HEAD` (`git clone --depth 1 file://…`), index rebuilt against
 *   the staged tree, `origin` re-pointed at {@link ORG_REMOTE} so
 *   `pushBranch`/`openPullRequest` publish to the real repository.
 *
 * Fingerprinted by the HEAD commits (root + distilled, read from the
 * filesystem) and skipped when already staged, so a plan that changed
 * nothing costs two file reads, not a re-stage. File modes are
 * normalized to what the artifact zip roundtrip produces anyway,
 * keeping local (floci) docker layer caches stable across stagings.
 */
export const stageBake: Effect.Effect<
  StagedBake,
  never,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner
> = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const root = REPO_ROOT;
  const head = yield* readHead(root);
  const distilledHead = yield* readHead(path.join(root, "distilled"));
  const fingerprint = `${STAGE_VERSION}:${head}:${distilledHead}`;

  const base = path.join(
    root,
    "services",
    "alchemy-org",
    ".alchemy",
    "tmp",
    "sandbox-bake",
  );
  const dir = path.join(base, "alchemy");
  const markerPath = path.join(base, MARKER);

  const staged = yield* fs
    .readFileString(markerPath)
    .pipe(Effect.orElseSucceed(() => ""));
  if (staged.trim() === fingerprint && (yield* fs.exists(dir))) {
    return { dir, fingerprint };
  }

  // Build the stage in a SCRATCH dir and atomically swap it into place
  // at the end — a concurrent reader (another plan, the warm-bake
  // script) sees the previous complete stage or the new one, never a
  // half-written tree.
  const scratch = path.join(base, ".next");
  const staging = path.join(scratch, "alchemy");
  yield* fs.remove(scratch, { recursive: true, force: true });
  yield* fs.makeDirectory(path.join(staging, "distilled"), {
    recursive: true,
  });

  // the committed tree — no gitignored cruft, no submodule content
  yield* sh(`git archive HEAD | tar -x -C ${q(staging)}`, root);
  // distilled ships as plain committed files (bun install + the test
  // runner resolve it from src; sessions don't need its history)
  yield* sh(
    `git -C distilled archive HEAD | tar -x -C ${q(path.join(staging, "distilled"))}`,
    root,
  );
  // a REAL .git: depth-1 pack of HEAD from the LOCAL object store
  const cloneTmp = path.join(scratch, ".gitclone");
  yield* sh(
    `git clone --quiet --depth 1 --no-checkout file://${q(root)} ${q(cloneTmp)}`,
  );
  yield* fs.rename(path.join(cloneTmp, ".git"), path.join(staging, ".git"));
  yield* fs.remove(cloneTmp, { recursive: true, force: true });
  // the staged tree IS HEAD's tree — rebuild the index against it
  yield* sh("git reset --quiet", staging);
  // sessions publish to the real origin, not the file:// staging source
  yield* sh(`git remote set-url origin ${ORG_REMOTE}`, staging);
  // distilled is plain files here — silence submodule status noise
  yield* sh("git config submodule.distilled.ignore all", staging);
  // normalize modes to the artifact zip roundtrip's (644 files, 755
  // dirs — exec bits don't survive the zip) so local docker COPY layer
  // caches agree between warm-bake stagings and floci builds
  yield* sh(`find ${q(staging)} -type f -exec chmod 644 {} +`);
  yield* sh(`find ${q(staging)} -type d -exec chmod 755 {} +`);

  // trust nothing implicit: the stage must LOOK like the repo
  for (const probe of ["package.json", "distilled/package.json", ".git/HEAD"]) {
    if (!(yield* fs.exists(path.join(staging, probe)))) {
      return yield* Effect.fail(
        new BakeError(`staging incomplete: missing ${probe} in ${staging}`),
      );
    }
  }

  // the swap: retire the old stage, move the new one into place
  yield* fs.remove(dir, { recursive: true, force: true });
  yield* fs.rename(staging, dir);
  yield* fs.remove(scratch, { recursive: true, force: true });
  yield* fs.writeFileString(markerPath, fingerprint);
  return { dir, fingerprint };
}).pipe(Effect.orDie);
