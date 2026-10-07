/**
 * INTERNAL — per-session workspaces for a harness running on this machine
 * under `alchemy dev` (`AI.LocalHarness`).
 *
 * In a container every session is alone in its box, so a mounted repository
 * is simply its mount path. On the host one harness process serves every
 * session, so each session gets its own `git worktree` of the mount's
 * prepared checkout under `ALCHEMY_WORKTREES/<session>/`, with the prepared
 * build outputs (`node_modules`, compiled output, build info — whatever git
 * ignores) copied across so the worktree is ready to work in immediately.
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
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

const run = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner;
    const child = yield* spawner.spawn(
      ChildProcess.make("git", [...args], {
        cwd,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        extendEnv: true,
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
        message: `git ${args.join(" ")} failed in ${cwd}: ${stderr.trim()}`,
      });
    }
    return stdout;
  }).pipe(
    Effect.scoped,
    Effect.catchTag("PlatformError", (e) =>
      Effect.fail(new SessionError({ message: `git: ${e.message}` })),
    ),
  );

/**
 * Copy what git ignores in `from` (dependencies, build outputs) into the
 * same places in `to`. Dependencies are hard-linked: nothing edits them in
 * place, and there can be a lot of them.
 */
const copyIgnored = (from: string, to: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const listed = yield* run(from, [
      "ls-files",
      "--others",
      "--ignored",
      "--exclude-standard",
      "--directory",
      "-z",
    ]);
    const entries = listed.split("\0").filter((entry) => entry.length > 0);
    const isDependency = (relative: string) => relative.split("/").includes("node_modules");
    yield* Effect.forEach(
      entries,
      (entry) =>
        Effect.gen(function* () {
          const relative = entry.replace(/\/$/, "");
          const src = path.join(from, relative);
          const dst = path.join(to, relative);
          if (entry.endsWith("/")) {
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
      Effect.fail(new SessionError({ message: `copying build outputs: ${e.message}` })),
    ),
  );

/** One session's worktree of one prepared checkout (and its submodules). */
const createWorktree = (prepared: string, dir: string, sessionId: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(path.dirname(dir), { recursive: true });
    yield* run(prepared, ["worktree", "add", "--force", "-B", `session/${sessionId}`, dir, "HEAD"]);
    yield* copyIgnored(prepared, dir);
    // Submodules are repositories of their own: a worktree each — only the
    // checked-out ones (an uninitialized submodule's empty directory would
    // resolve to the parent repository).
    const initialized = yield* run(prepared, ["submodule", "foreach", "--quiet", "echo $sm_path"]);
    for (const sub of initialized.split("\n").filter((l) => l.trim().length > 0)) {
      const subPrepared = path.join(prepared, sub);
      const subDir = path.join(dir, sub);
      yield* fs.remove(subDir, { recursive: true, force: true });
      yield* run(subPrepared, ["worktree", "add", "--force", "--detach", subDir, "HEAD"]);
      yield* copyIgnored(subPrepared, subDir);
    }
  }).pipe(
    Effect.catchTag("PlatformError", (e) =>
      Effect.fail(new SessionError({ sessionId, message: `creating worktree: ${e.message}` })),
    ),
  );

const locks = new Map<string, Semaphore.Semaphore>();
const lockFor = (dir: string) => {
  let lock = locks.get(dir);
  if (!lock) {
    lock = Semaphore.makeUnsafe(1);
    locks.set(dir, lock);
  }
  return lock;
};

/**
 * The directory a session works in. Outside `alchemy dev` (or for a path no
 * repository is mounted at) it is `cwd` unchanged; on the host, a path in a
 * mounted repository maps into the session's own worktree of it, created on
 * first use.
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
    const dir = path.join(root, safe, path.basename(mountPath));
    yield* lockFor(dir).withPermits(1)(
      Effect.gen(function* () {
        if (yield* fs.exists(path.join(dir, ".git"))) return;
        yield* createWorktree(prepared, dir, safe);
      }),
    );
    return path.join(dir, cwd.slice(mountPath.length));
  }).pipe(
    Effect.catchTag("PlatformError", (e) =>
      Effect.fail(new SessionError({ sessionId, message: e.message })),
    ),
  );
