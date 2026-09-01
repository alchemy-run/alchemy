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
const STAGE_VERSION = "v4";

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
  /** Cheap content identity — feed to `fingerprint`. */
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
 * The commit a checkout's HEAD points at, read from the FILESYSTEM
 * (HEAD → loose ref → packed-refs) — no git subprocess involved.
 */
const readHead = (checkout: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dotGit = path.join(checkout, ".git");
    const info = yield* fs.stat(dotGit);
    const gitDir = yield* Effect.gen(function* () {
      if (info.type === "Directory") return dotGit;
      // a submodule checkout's .git is a FILE containing `gitdir: <path>`
      const pointer = (yield* fs.readFileString(dotGit)).trim();
      const target = pointer.replace(/^gitdir:\s*/, "");
      return path.isAbsolute(target) ? target : path.resolve(checkout, target);
    });
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
 * A cheap identity for "what would this stage contain?": the HEAD
 * commits (root + distilled), plus the dirty paths of the root repo
 * with their mtime+size, plus the mtime+size of every build artifact
 * marker that ships (tsbuildinfo, the floci jar). Written through
 * files, never captured stdout (see {@link REPO_ROOT}).
 */
const computeFingerprint = (scratchDir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = REPO_ROOT;

    const head = yield* readHead(root);
    const distilledHead = yield* readHead(path.join(root, "distilled"));

    // dirty state: the porcelain listing names every changed/untracked
    // path; stat each so edits to already-dirty files also move the
    // fingerprint
    const porcelainFile = path.join(scratchDir, ".porcelain");
    yield* sh(`git status --porcelain > ${q(porcelainFile)}`, root);
    const porcelain = yield* fs.readFileString(porcelainFile);
    const statOf = (rel: string) =>
      fs.stat(path.join(root, rel)).pipe(
        Effect.map((info) => {
          const mtime =
            info.mtime._tag === "Some" ? info.mtime.value.getTime() : 0;
          return `${rel}:${mtime}:${String(info.size)}`;
        }),
        Effect.orElseSucceed(() => `${rel}:gone`),
      );
    const dirtyStats: string[] = [];
    for (const line of porcelain.split("\n")) {
      if (line.length < 4) continue;
      // porcelain v1: XY <path>[ -> <path>]
      const rel = line.slice(3).split(" -> ").pop()!.replace(/^"|"$/g, "");
      dirtyStats.push(yield* statOf(rel));
    }

    // build-artifact identity: tsbuildinfo files move whenever tsc -b
    // recompiled anything; the floci jar whenever it was repackaged
    const artifactsFile = path.join(scratchDir, ".artifacts");
    yield* sh(
      `{ find . packages services distilled -maxdepth 4 -name '*.tsbuildinfo' 2>/dev/null; ls .vendor/floci/target/quarkus-app/quarkus-run.jar 2>/dev/null; } | ` +
        `xargs stat -f '%N %m %z' 2>/dev/null | sort > ${q(artifactsFile)} || true`,
      root,
    );
    const artifacts = yield* fs
      .readFileString(artifactsFile)
      .pipe(Effect.orElseSucceed(() => ""));

    const digest = yield* Effect.sync(() =>
      new Bun.CryptoHasher("sha256")
        .update(
          [porcelain, ...dirtyStats, artifacts].join("\u0000"),
        )
        .digest("hex")
        .slice(0, 16),
    );
    return `${STAGE_VERSION}:${head}:${distilledHead}:${digest}`;
  });

/**
 * Stage the LOCAL repository for the sandbox image bake — a dumb
 * WHOLESALE COPY of the working tree (uncommitted edits included),
 * plus a locally-crafted shallow `.git`. Nothing is built here and
 * nothing is built in the image beyond linux `node_modules`: whatever
 * the host has compiled (`lib/`, `dist/`, tsbuildinfo, the floci jar)
 * ships as-is.
 *
 * What ships:
 * - the working tree, minus what CANNOT ship: `node_modules`
 *   (darwin-native binaries), `.env*` (secrets), machine-local state
 *   (`.alchemy`, `.turbo`, `.wrangler`, `.claude`), and every nested
 *   `.git` (submodule pointers are meaningless off-host);
 * - `.vendor/floci` WITH its locally-built `target/` — build it on
 *   the host (`./mvnw -DskipTests package`) and the VM runs the jar;
 *   the rest of `.vendor` (vendored framework repos) stays home;
 * - a REAL `.git`, pruned to depth 1 WITHOUT touching the local repo:
 *   `git clone --depth 1 --no-checkout file://<root>` negotiates a
 *   single-commit pack from the local object store (HEAD's commit +
 *   tree + blobs — none of the worktree/submodule gitdir tonnage),
 *   the index is rebuilt against it, and `origin` is re-pointed at
 *   {@link ORG_REMOTE} so sessions publish to the real repository.
 *
 * The staging directory is PERSISTENT and rsync'd with `--delete`, so
 * a re-stage is an incremental delta, not a fresh copy. Fingerprinted
 * by HEAD + dirty-file stats + build-artifact stats, so host rebuilds
 * and edits re-stage, and an unchanged workspace is a no-op.
 */
export const stageBake: Effect.Effect<
  StagedBake,
  never,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner
> = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const root = REPO_ROOT;
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
  yield* fs.makeDirectory(base, { recursive: true });

  const fingerprint = yield* computeFingerprint(base);
  const staged = yield* fs
    .readFileString(markerPath)
    .pipe(Effect.orElseSucceed(() => ""));
  if (staged.trim() === fingerprint && (yield* fs.exists(dir))) {
    return { dir, fingerprint };
  }
  // a re-stage may be interrupted — clear the marker up front so a
  // torn stage is never mistaken for the fingerprint it claims
  yield* fs.remove(markerPath, { force: true });

  // ── the working tree, wholesale ──────────────────────────────────
  // rsync --delete into the PERSISTENT staging dir: unchanged files
  // are untouched (delta copy), removals propagate. Two passes keep
  // the exclude logic trivial across rsync dialects (macOS ships
  // openrsync): everything minus .vendor, then .vendor/floci alone.
  const rsync = (from: string, to: string, excludes: ReadonlyArray<string>) =>
    sh(
      `rsync -a --delete ${excludes
        .map((pattern) => `--exclude=${q(pattern)}`)
        .join(" ")} ${q(`${from}/`)} ${q(to)}`,
    );
  yield* rsync(root, dir, [
    ".git",
    "node_modules",
    "/.vendor",
    "/.claude",
    ".alchemy",
    ".turbo",
    ".wrangler",
    ".tmp",
    ".DS_Store",
    ".env*",
  ]);
  yield* fs.makeDirectory(path.join(dir, ".vendor", "floci"), {
    recursive: true,
  });
  yield* rsync(
    path.join(root, ".vendor", "floci"),
    path.join(dir, ".vendor", "floci"),
    [".git", "node_modules", ".DS_Store"],
  );

  // ── a REAL .git: depth-1 pack of HEAD from the LOCAL object store ─
  const cloneTmp = path.join(base, ".gitclone");
  yield* fs.remove(cloneTmp, { recursive: true, force: true });
  yield* sh(
    `git clone --quiet --depth 1 --no-checkout file://${q(root)} ${q(cloneTmp)}`,
  );
  yield* fs.remove(path.join(dir, ".git"), { recursive: true, force: true });
  yield* fs.rename(path.join(cloneTmp, ".git"), path.join(dir, ".git"));
  yield* fs.remove(cloneTmp, { recursive: true, force: true });
  // rebuild the index against HEAD — the host's uncommitted edits show
  // as ordinary dirty diffs in the guest, exactly like on the host
  yield* sh("git reset --quiet", dir);
  // sessions publish to the real origin, not the file:// staging source
  yield* sh(`git remote set-url origin ${ORG_REMOTE}`, dir);
  // submodules ship as plain files here — silence their status noise
  yield* sh("git config submodule.distilled.ignore all", dir);
  yield* sh(`git config submodule."vendor/floci".ignore all`, dir);

  // trust nothing implicit: the stage must LOOK like the repo
  for (const probe of ["package.json", "distilled/package.json", ".git/HEAD"]) {
    if (!(yield* fs.exists(path.join(dir, probe)))) {
      return yield* Effect.fail(
        new BakeError(`staging incomplete: missing ${probe} in ${dir}`),
      );
    }
  }

  yield* fs.writeFileString(markerPath, fingerprint);
  return { dir, fingerprint };
}).pipe(Effect.orDie);
