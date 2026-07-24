import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { ChildProcess } from "effect/unstable/process";
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";
import { Credentials } from "./Credentials.ts";
import { defaultBranch, type Remote } from "./Remote.ts";
import { GitError, Workspaces, type Workspace } from "./Workspaces.ts";

export interface WorkspacesWorktreeOptions {
  /** Where the central clones and worktrees live. Created if missing. */
  readonly root: string;
}

const slug = (value: string): string =>
  value.replaceAll(/[^a-zA-Z0-9._-]+/g, "-").replaceAll(/^-+|-+$/g, "");

/** `https://github.com/owner/repo.git` → `github.com/owner/repo` */
const remoteSlug = (remote: Remote): string =>
  slug(remote.url.replace(/^[a-z+]+:\/\//, "").replace(/\.git$/, ""));

/**
 * The local {@link Workspaces} physics: ONE central blobless clone per
 * remote under `{root}/repos/…`, and `git worktree add` per key under
 * `{root}/trees/{key}` — per-run trees are cheap (no object copies,
 * shared store), isolated (each tree owns its branch), and addressable
 * (key → deterministic path and branch).
 *
 * Credentials resolve through the {@link Credentials} helper protocol
 * when provided. v1 embeds them in the central clone's remote URL so
 * every later `fetch`/`push` in any worktree authenticates — the
 * tradeoff is the credential at rest in `.git/config` of a local
 * working dir (same posture as a developer's `gh` setup); the askpass
 * upgrade slots in here without touching the contract.
 */
export const WorkspacesWorktree = (
  options: WorkspacesWorktreeOptions,
): Layer.Layer<
  Workspaces,
  never,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner | Credentials
> =>
  Layer.effect(
    Workspaces,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const credentials = yield* Credentials;
      const spawner = yield* Effect.context<ChildProcessSpawner>();

      const root = path.resolve(options.root);
      yield* fs.makeDirectory(root, { recursive: true }).pipe(Effect.orDie);

      const cache = yield* Ref.make<ReadonlyMap<string, Workspace>>(new Map());
      // one mutator at a time: clone/fetch/worktree ops share gitdirs
      const lock = yield* Semaphore.make(1);

      const git = (
        args: ReadonlyArray<string>,
      ): Effect.Effect<void, GitError> =>
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
              return yield* new GitError({
                command: args[0] === "-C" ? (args[2] ?? "") : (args[0] ?? ""),
                exitCode,
                stderr: stderr.trim(),
              });
            }
          }),
        ).pipe(
          Effect.provide(spawner),
          // spawn/stream failures are environmental defects, not git outcomes
          Effect.catch((error) =>
            error instanceof GitError ? Effect.fail(error) : Effect.die(error),
          ),
        );

      /** The clone URL, authenticated through the credential helper. */
      const authedUrl = (remote: Remote) =>
        Effect.map(credentials.for(remote), (found) =>
          Option.match(found, {
            onNone: () => remote.url,
            onSome: ({ username, password }) =>
              remote.url.replace(
                /^https:\/\//,
                `https://${encodeURIComponent(username)}:${encodeURIComponent(Redacted.value(password))}@`,
              ),
          }),
        );

      /** Central blobless clone for the remote — cloned once, fetched per checkout. */
      const ensureRepo = (remote: Remote, ref: string) =>
        Effect.gen(function* () {
          const repoDir = path.join(root, "repos", remoteSlug(remote));
          const cloned = yield* fs
            .exists(path.join(repoDir, ".git"))
            .pipe(Effect.orDie);
          if (!cloned) {
            yield* fs
              .makeDirectory(path.dirname(repoDir), { recursive: true })
              .pipe(Effect.orDie);
            const url = yield* authedUrl(remote);
            yield* git(["clone", "--filter=blob:none", url, repoDir]);
          } else {
            yield* git(["-C", repoDir, "fetch", "origin", ref]);
          }
          return repoDir;
        });

      const build = (key: string, remote: Remote, ref: string) =>
        Effect.gen(function* () {
          const treeSlug = slug(key);
          const repoDir = yield* ensureRepo(remote, ref);
          const treeDir = path.join(root, "trees", treeSlug);
          const exists = yield* fs.exists(treeDir).pipe(Effect.orDie);
          if (!exists) {
            yield* git([
              "-C",
              repoDir,
              "worktree",
              "add",
              "-B",
              `ws/${treeSlug}`,
              treeDir,
              `origin/${ref}`,
            ]);
          }
          const workspace: Workspace = {
            key,
            root: treeDir,
            path: path.join("trees", treeSlug),
            branch: `ws/${treeSlug}`,
            remote,
          };
          yield* Ref.update(cache, (map) => new Map(map).set(key, workspace));
          return workspace;
        });

      const drop = (workspace: Workspace) =>
        Effect.gen(function* () {
          const repoDir = path.join(
            root,
            "repos",
            remoteSlug(workspace.remote),
          );
          // already-gone is success: drops are idempotent
          yield* git([
            "-C",
            repoDir,
            "worktree",
            "remove",
            "--force",
            workspace.root,
          ]).pipe(Effect.catchTag("Git.GitError", () => Effect.void));
          yield* git(["-C", repoDir, "branch", "-D", workspace.branch]).pipe(
            Effect.catchTag("Git.GitError", () => Effect.void),
          );
          yield* Ref.update(cache, (map) => {
            const next = new Map(map);
            next.delete(workspace.key);
            return next;
          });
        });

      return {
        checkout: ({ key, remote, ref, fresh }) =>
          lock.withPermits(1)(
            Effect.gen(function* () {
              const base = ref ?? defaultBranch(remote);
              const cached = (yield* Ref.get(cache)).get(key);
              if (cached !== undefined && fresh !== true) {
                const alive = yield* fs.exists(cached.root).pipe(Effect.orDie);
                if (alive) return cached;
              }
              if (cached !== undefined && fresh === true) {
                yield* drop(cached);
              }
              return yield* build(key, remote, base);
            }),
          ),
        get: (key) =>
          Ref.get(cache).pipe(
            Effect.map((map) => Option.fromNullishOr(map.get(key))),
          ),
        release: (key) =>
          lock.withPermits(1)(
            Effect.gen(function* () {
              const cached = (yield* Ref.get(cache)).get(key);
              if (cached !== undefined) yield* drop(cached);
            }),
          ),
      };
    }),
  );
