/**
 * INTERNAL — per-session workspaces for a harness running on this machine
 * under `alchemy dev` (`AI.LocalHarness`).
 *
 * In a container every session is alone in its box, so a mounted repository
 * is simply its mount path. On the host one harness process serves every
 * session, so each session gets its own `git worktree` of the mount's
 * prepared checkout under `ALCHEMY_WORKTREES/<session>/`:
 *
 * - every initialized submodule is a linked worktree of the prepared
 *   checkout's own submodule repository (one object store), with its
 *   `core.worktree` pinned per worktree so no checkout redirects another;
 * - what git ignores (`node_modules`, compiled output, build info) is
 *   seeded from the prepared checkout with APFS `clonefile(2)` —
 *   copy-on-write, so the session's installs and builds stay its own;
 * - one spare worktree per prepared checkout is kept ready in the
 *   background, so a new session claims a finished tree with a rename.
 */
import * as Crypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/process/ChildProcess";
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { copyTree } from "../Docker/CopyTree.ts";
import { SessionError } from "./Session.ts";

/** Mount path in the program's filesystem → prepared checkout on this machine. */
const localMounts = (): Record<string, string> => {
  try {
    return JSON.parse(process.env.ALCHEMY_LOCAL_MOUNTS ?? "{}");
  } catch {
    return {};
  }
};

const exec = (
  command: string,
  args: ReadonlyArray<string>,
  cwd: string,
  env?: Record<string, string>,
) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner;
    const child = yield* spawner.spawn(
      ChildProcess.make(command, [...args], {
        cwd,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        extendEnv: true,
        env,
      }),
    );
    const [exitCode, stdout, stderr] = yield* Effect.all(
      [
        child.exitCode,
        child.stdout.pipe(Stream.decodeText, Stream.mkString),
        child.stderr.pipe(Stream.decodeText, Stream.mkString),
      ],
      { concurrency: "unbounded" },
    );
    if (exitCode !== 0) {
      return yield* new SessionError({
        message: `${command} ${args.join(" ")} failed in ${cwd}: ${stderr.trim()}`,
      });
    }
    return stdout;
  }).pipe(
    Effect.scoped,
    Effect.catchTag("PlatformError", (e) =>
      Effect.fail(new SessionError({ message: `${command}: ${e.message}` })),
    ),
  );

/**
 * git, without the repository's own hooks: a `post-checkout` bootstrap is
 * not ours to run, and races between concurrent sessions.
 */
const git = (cwd: string, args: ReadonlyArray<string>) =>
  exec("git", ["-c", "core.hooksPath=/dev/null", ...args], cwd);

const locks = new Map<string, Semaphore.Semaphore>();
const lockFor = (key: string) => {
  let lock = locks.get(key);
  if (!lock) {
    lock = Semaphore.makeUnsafe(1);
    locks.set(key, lock);
  }
  return lock;
};

/** The initialized submodules of a checkout (an uninitialized one's empty
 *  directory would resolve to the parent repository). */
const submodules = (checkout: string) =>
  git(checkout, ["submodule", "foreach", "--quiet", "echo $sm_path"]).pipe(
    Effect.map((out) => out.split("\n").filter((line) => line.trim().length > 0)),
  );

/**
 * Pin `core.worktree` per worktree in a submodule's repository. A
 * submodule's shared config carries the primary checkout's path in
 * `core.worktree`, which every linked worktree would inherit — git there
 * would then operate on the primary checkout's files. Each worktree
 * (primary and linked) gets its own path in `config.worktree` instead.
 */
const isolateSubmodule = (checkout: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const common = (yield* git(checkout, [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ])).trim();
    const configs: Array<[admin: string, worktree: string]> = [[common, checkout]];
    const worktrees = path.join(common, "worktrees");
    if (yield* fs.exists(worktrees)) {
      for (const entry of yield* fs.readDirectory(worktrees)) {
        const admin = path.join(worktrees, entry);
        const gitfile = yield* fs.readFileString(path.join(admin, "gitdir")).pipe(Effect.option);
        if (Option.isNone(gitfile)) continue;
        configs.push([admin, path.dirname(path.resolve(admin, gitfile.value.trim()))]);
      }
    }
    for (const [admin, worktree] of configs) {
      yield* git(checkout, [
        "config",
        "--file",
        path.join(admin, "config.worktree"),
        "core.worktree",
        worktree,
      ]);
    }
    const config = path.join(common, "config");
    yield* git(checkout, ["config", "--file", config, "extensions.worktreeConfig", "true"]);
    yield* git(checkout, ["config", "--file", config, "--unset-all", "core.worktree"]).pipe(
      Effect.ignore,
    );
  }).pipe(
    Effect.catchTag("PlatformError", (e) =>
      Effect.fail(new SessionError({ message: `isolating ${checkout}: ${e.message}` })),
    ),
  );

/**
 * Clone paths with `clonefile(2)` (APFS copy-on-write: a directory tree in
 * one call, sharing every data block, writes private to the clone). Node has
 * no binding for it, so it is reached through bun's FFI in a child process.
 * Returns the pairs that could not be cloned (another platform, no bun,
 * another volume) for the caller to copy.
 */
const CLONE = `
const { dlopen, FFIType, suffix } = require("bun:ffi");
const fs = require("node:fs");
const path = require("node:path");
const lib = dlopen("libSystem." + suffix, {
  clonefile: { args: [FFIType.cstring, FFIType.cstring, FFIType.u32], returns: FFIType.i32 },
});
// CLONE_NOFOLLOW: a symlink is cloned as the link itself.
const clone = (src, dst) =>
  lib.symbols.clonefile(Buffer.from(src + "\\0"), Buffer.from(dst + "\\0"), 1) === 0;
const { from, to, entries } = JSON.parse(fs.readFileSync(process.env.ALCHEMY_CLONE_LIST, "utf8"));
// An entry whose directory the checkout doesn't have holds nothing tracked:
// clone its highest missing ancestor once instead (git lists the ignored
// files of a partly tracked directory one by one).
const targets = new Set();
for (const entry of entries) {
  let target = entry;
  for (let up = path.dirname(entry); up !== "." && !fs.existsSync(path.join(to, up)); up = path.dirname(up)) {
    target = up;
  }
  targets.add(target);
}
const failed = [];
for (const target of targets) {
  const src = path.join(from, target);
  const dst = path.join(to, target);
  if (clone(src, dst)) continue;
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.rmSync(dst, { recursive: true, force: true });
  if (!clone(src, dst)) failed.push([src, dst]);
}
process.stdout.write(JSON.stringify(failed));
`;

const clonePaths = (from: string, to: string, entries: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const pairs = entries.map((entry) => [path.join(from, entry), path.join(to, entry)] as const);
    if (process.platform !== "darwin" || pairs.length === 0) return pairs;
    const fs = yield* FileSystem.FileSystem;
    const list = yield* fs.makeTempFileScoped({ suffix: ".json" });
    yield* fs.writeFileString(list, JSON.stringify({ from, to, entries }));
    return yield* exec("bun", ["-e", CLONE], process.cwd(), { ALCHEMY_CLONE_LIST: list }).pipe(
      Effect.map((out) => JSON.parse(out) as ReadonlyArray<readonly [string, string]>),
      // No bun (or no FFI): copy everything instead.
      Effect.catch(() => Effect.succeed(pairs)),
    );
  }).pipe(Effect.scoped);

/**
 * Seed what git ignores in `from` (dependencies, build outputs) into the
 * same places in `to` — cloned where the platform allows, else copied
 * (dependencies hard-linked: nothing edits them in place).
 */
const seedIgnored = (from: string, to: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const listed = yield* git(from, [
      "ls-files",
      "--others",
      "--ignored",
      "--exclude-standard",
      "--directory",
      "-z",
    ]);
    const entries = listed
      .split("\0")
      .filter((entry) => entry.length > 0)
      .map((entry) => entry.replace(/\/$/, ""));
    const failed = yield* clonePaths(from, to, entries);
    const isDependency = (relative: string) => relative.split("/").includes("node_modules");
    yield* Effect.forEach(
      failed,
      ([src, dst]) =>
        Effect.gen(function* () {
          const relative = path.relative(from, src);
          const info = yield* fs.stat(src);
          if (info.type === "Directory") {
            return yield* copyTree(src, dst, {
              link: (inner) => isDependency(`${relative}/${inner}`),
            });
          }
          yield* fs.makeDirectory(path.dirname(dst), { recursive: true });
          yield* fs.remove(dst, { force: true });
          yield* isDependency(relative) ? fs.link(src, dst) : fs.copyFile(src, dst);
        }),
      { concurrency: 8, discard: true },
    );
  }).pipe(
    Effect.catchTag("PlatformError", (e) =>
      Effect.fail(new SessionError({ message: `seeding build outputs: ${e.message}` })),
    ),
  );

/** A worktree of a prepared checkout (and of its submodules) at `dir`, on `branch`. */
const createWorktree = (prepared: string, dir: string, branch: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(path.dirname(dir), { recursive: true });
    yield* lockFor(prepared).withPermits(1)(
      git(prepared, ["worktree", "add", "--force", "-B", branch, dir, "HEAD"]),
    );
    const subs = yield* submodules(prepared);
    for (const sub of subs) {
      const subPrepared = path.join(prepared, sub);
      const subDir = path.join(dir, sub);
      yield* fs.remove(subDir, { recursive: true, force: true });
      yield* lockFor(subPrepared).withPermits(1)(
        Effect.gen(function* () {
          yield* git(subPrepared, ["worktree", "prune"]);
          yield* isolateSubmodule(subPrepared);
          yield* git(subPrepared, ["worktree", "add", "--force", "--detach", subDir, "HEAD"]);
          yield* isolateSubmodule(subPrepared);
        }),
      );
    }
    // Seed the superproject and each submodule from their prepared twins.
    yield* seedIgnored(prepared, dir);
    for (const sub of subs) {
      yield* seedIgnored(path.join(prepared, sub), path.join(dir, sub));
    }
  }).pipe(
    Effect.catchTag("PlatformError", (e) =>
      Effect.fail(new SessionError({ message: `creating worktree ${dir}: ${e.message}` })),
    ),
  );

//#region spares

const SPARES = ".spares";
/** Written beside a spare's worktree once it is complete. */
const READY = ".ready";

/** Which prepared checkout a spare belongs to: a short digest of its path. */
const spareKey = (prepared: string) =>
  Crypto.createHash("sha256").update(prepared).digest("hex").slice(0, 12);

/** The spares of `prepared` that are ready to claim. */
const readySpares = (root: string, prepared: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = path.join(root, SPARES);
    if (!(yield* fs.exists(dir))) return [];
    const key = spareKey(prepared);
    const ready: Array<string> = [];
    for (const entry of yield* fs.readDirectory(dir)) {
      if (entry.startsWith(`${key}-`) && (yield* fs.exists(path.join(dir, entry, READY)))) {
        ready.push(path.join(dir, entry));
      }
    }
    return ready;
  });

/** Keep one spare worktree of `prepared` ready, built in the background. */
const ensureSpare = (root: string, prepared: string, name: string) =>
  lockFor(`spare:${prepared}`)
    .withPermits(1)(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        if ((yield* readySpares(root, prepared)).length > 0) return;
        const id = `${spareKey(prepared)}-${Date.now().toString(36)}`;
        const spare = path.join(root, SPARES, id);
        yield* createWorktree(prepared, path.join(spare, name), `spare/${id}`);
        yield* fs.writeFileString(path.join(spare, READY), prepared);
      }),
    )
    .pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning(`preparing a spare worktree of ${prepared} failed`, cause),
      ),
    );

/**
 * Take a ready spare of `prepared` for a session: rename its worktree to
 * `dir`, point git's records (superproject and submodules) at the new place,
 * and rename its branch. `false` when no spare is ready. Shares the spare
 * builder's lock, so a session arriving mid-build waits for that spare
 * rather than starting another from scratch.
 */
const claimSpare = (root: string, prepared: string, name: string, dir: string, branch: string) =>
  lockFor(`spare:${prepared}`)
    .withPermits(1)(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const [spare] = yield* readySpares(root, prepared);
        if (spare === undefined) return false;
        yield* fs.makeDirectory(path.dirname(dir), { recursive: true });
        yield* fs.rename(path.join(spare, name), dir);
        yield* fs.remove(spare, { recursive: true, force: true });
        yield* lockFor(prepared).withPermits(1)(git(prepared, ["worktree", "repair", dir]));
        for (const sub of yield* submodules(dir)) {
          const subPrepared = path.join(prepared, sub);
          yield* lockFor(subPrepared).withPermits(1)(
            Effect.gen(function* () {
              yield* git(subPrepared, ["worktree", "repair", path.join(dir, sub)]);
              yield* isolateSubmodule(subPrepared);
            }),
          );
        }
        yield* git(dir, ["branch", "-M", branch]);
        return true;
      }),
    )
    .pipe(
      Effect.catchTag("PlatformError", (e) =>
        Effect.fail(new SessionError({ message: `claiming a spare worktree: ${e.message}` })),
      ),
    );

//#endregion

/**
 * Start preparing a spare worktree of every locally mounted repository, so
 * the first session doesn't wait for one. A no-op outside `alchemy dev`.
 */
export const prewarmWorkspaces = Effect.gen(function* () {
  const root = process.env.ALCHEMY_WORKTREES;
  if (!root) return;
  const path = yield* Path.Path;
  for (const [mountPath, prepared] of Object.entries(localMounts())) {
    yield* Effect.forkDetach(ensureSpare(root, prepared, path.basename(mountPath)));
  }
});

/**
 * The directory a session works in. Outside `alchemy dev` (or for a path no
 * repository is mounted at) it is `cwd` unchanged; on the host, a path in a
 * mounted repository maps into the session's own worktree of it — a ready
 * spare when there is one, else created on first use.
 */
export const sessionCwd = (cwd: string, sessionId: string) =>
  Effect.gen(function* () {
    const root = process.env.ALCHEMY_WORKTREES;
    if (!root) return cwd;
    const mount = Object.entries(localMounts()).find(
      ([mountPath]) => cwd === mountPath || cwd.startsWith(`${mountPath}/`),
    );
    if (!mount) return cwd;
    const [mountPath, prepared] = mount;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const safe = sessionId.replace(/[^\w.-]/g, "_");
    const name = path.basename(mountPath);
    const dir = path.join(root, safe, name);
    yield* lockFor(dir).withPermits(1)(
      Effect.gen(function* () {
        if (yield* fs.exists(path.join(dir, ".git"))) return;
        const branch = `session/${safe}`;
        if (!(yield* claimSpare(root, prepared, name, dir, branch))) {
          yield* createWorktree(prepared, dir, branch);
        }
        // Replace what was taken, for the next session.
        yield* Effect.forkDetach(ensureSpare(root, prepared, name));
      }),
    );
    return path.join(dir, cwd.slice(mountPath.length));
  }).pipe(
    Effect.catchTag("PlatformError", (e) =>
      Effect.fail(new SessionError({ sessionId, message: e.message })),
    ),
  );
