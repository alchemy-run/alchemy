// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
/**
 * Startup lock for a shared storage directory, ported from Miniflare's
 * `persist-root-lock.ts` (`workers-sdk/packages/miniflare/src/shared`).
 *
 * workerd opens every simulator's `metadata.sqlite` while it boots. When
 * several runtimes host the shared storage simulators for one directory,
 * their boots are serialized so they never initialize those files at the
 * same moment. Runtimes in this process wait on an in-memory semaphore;
 * other processes are excluded by an exclusive lock file.
 */
import * as Crypto from "node:crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import { SystemError } from "../RuntimeError.shared.ts";

export const LOCK_NAME = ".cloudflare-runtime-startup.lock";
/** Startup is bounded, so an older lock belongs to a failed startup attempt. */
export const LOCK_STALE_MS = 30_000;
const LOCK_RETRY_MS = 50;
/**
 * Generous enough to outlast a stale lock being reclaimed, low enough that a
 * lock we can never remove fails loudly instead of hanging startup forever.
 */
const LOCK_MAX_ATTEMPTS = 2 * Math.ceil(LOCK_STALE_MS / LOCK_RETRY_MS);

const isReason = (error: PlatformError, tag: string) => error.reason._tag === tag;

/** One semaphore per lock directory, shared by every runtime in this process. */
const semaphores = new Map<string, Semaphore.Semaphore>();
const semaphoreFor = (directory: string) => {
  let semaphore = semaphores.get(directory);
  if (!semaphore) {
    semaphore = Semaphore.makeUnsafe(1);
    semaphores.set(directory, semaphore);
  }
  return semaphore;
};

/**
 * Resolve a storage directory to a stable identity that every process agrees
 * on, so runtimes sharing a directory compute the same ownership scope.
 * Creates the directory if it is missing; lowercased on Windows, where paths
 * are case-insensitive.
 */
export const canonicalizeDirectory = Effect.fnUntraced(function* (directory: string) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.makeDirectory(directory, { recursive: true });
  const canonical = yield* fs.realPath(directory);
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
});

/**
 * Run `effect` while holding an exclusive lock on each of `directories`
 * (acquired in sorted order, so two runtimes never wait on each other).
 */
export const withStartupLocks = <A, E, R>(
  directories: ReadonlyArray<string>,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | SystemError, R | FileSystem.FileSystem | Path.Path> =>
  [...new Set(directories)]
    .sort()
    .reduceRight<Effect.Effect<A, E | SystemError, R | FileSystem.FileSystem | Path.Path>>(
      (inner, directory) => withStartupLock(directory, inner),
      effect,
    );

/** Run `effect` while holding the startup lock for `directory`. */
export const withStartupLock = <A, E, R>(
  directory: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | SystemError, R | FileSystem.FileSystem | Path.Path> =>
  semaphoreFor(directory).withPermits(1)(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const lockPath = path.join(directory, LOCK_NAME);
      const token = Crypto.randomUUID();

      const fail = (message: string, cause?: unknown) =>
        SystemError.make({
          subtag: "StartupLock",
          message,
          hint: "If no other dev session is running, delete the lock file and retry.",
          detail: { lockPath },
          cause,
        });

      /** The lock's token, or `undefined` if it doesn't exist. */
      const readLock = fs.readFileString(lockPath).pipe(
        Effect.catchIf(
          (error) => isReason(error, "NotFound"),
          () => Effect.undefined,
        ),
      );

      /**
       * Remove the lock if it has outlived {@link LOCK_STALE_MS}, which
       * means the process that wrote it died before releasing it. The token
       * is checked again right before removal, so a contender that already
       * reclaimed the stale lock and acquired a fresh one keeps it.
       */
      const removeStaleLock = Effect.gen(function* () {
        const staleToken = yield* readLock;
        if (staleToken === undefined) return;
        const info = yield* fs.stat(lockPath);
        const mtime = Option.getOrUndefined(info.mtime)?.getTime();
        // File mtimes are wall-clock time, so compare against it, never a test clock.
        // oxlint-disable-next-line effecttsgo/global-date-in-effect -- compared with a file mtime
        const now = Date.now();
        if (mtime === undefined || mtime >= now - LOCK_STALE_MS) return;
        if ((yield* readLock) === staleToken) {
          yield* fs.remove(lockPath, { force: true });
        }
      }).pipe(
        Effect.catchIf(
          (error) => isReason(error, "NotFound"),
          () => Effect.void,
        ),
      );

      /**
       * Remove the lock only if we still hold it, so we never delete a lock
       * another process acquired after ours was reclaimed as stale.
       */
      const removeOwnedLock = readLock.pipe(
        Effect.flatMap((current) =>
          current === token ? fs.remove(lockPath, { force: true }) : Effect.void,
        ),
        Effect.ignore,
      );

      const acquire = Effect.gen(function* () {
        yield* fs.makeDirectory(directory, { recursive: true });
        for (let attempt = 0; ; attempt++) {
          const written = yield* fs
            .writeFileString(lockPath, token, { flag: "wx", mode: 0o600 })
            .pipe(
              Effect.as(true),
              Effect.catchIf(
                (error) => isReason(error, "AlreadyExists"),
                () => Effect.succeed(false),
              ),
            );
          if (written) return;
          if (attempt >= LOCK_MAX_ATTEMPTS) {
            return yield* fail(
              `Timed out waiting for the runtime startup lock at ${lockPath}. Another process may still be holding it.`,
            );
          }
          yield* removeStaleLock;
          yield* Effect.sleep(Duration.millis(LOCK_RETRY_MS));
        }
      }).pipe(
        Effect.catchTag("PlatformError", (cause) =>
          Effect.fail(fail(`Failed to acquire the runtime startup lock at ${lockPath}.`, cause)),
        ),
      );

      // Touch the lock while it is held, so a slow startup (cold disk, a
      // debugger) is never reclaimed as stale by another process.
      const keepFresh = Effect.sync(
        // oxlint-disable-next-line effecttsgo/global-date-in-effect -- the mtime other processes compare with wall-clock time
        () => new Date(),
      ).pipe(
        Effect.flatMap((now) => fs.utimes(lockPath, now, now)),
        Effect.ignore,
        Effect.schedule(Schedule.spaced(Duration.millis(LOCK_STALE_MS / 3))),
      );

      return yield* Effect.acquireUseRelease(
        acquire.pipe(Effect.andThen(Effect.forkDetach(keepFresh))),
        () => effect,
        (fiber) => Fiber.interrupt(fiber).pipe(Effect.andThen(removeOwnedLock)),
      );
    }),
  );
