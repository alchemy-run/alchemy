import { lock } from "@alchemy.run/node-utils/lockfile";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import * as fs from "node:fs/promises";
import * as path from "pathe";

/**
 * A cross-process, key-partitioned mutex with a `PartitionedSemaphore`-style
 * interface. Within a process, callers holding different keys run
 * concurrently while same-key callers queue; across processes on the same
 * machine, the critical section is guarded by an OS lockfile
 * (`@alchemy.run/node-utils/lockfile`, a `proper-lockfile` fork).
 *
 * The lockfile primitive is a mutex, so this is always single-permit per key.
 */
export interface FileSemaphore {
  readonly withPermit: (
    key: string,
  ) => <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
}

/**
 * Make a lock key safe to use as a file name on every platform. Collapses
 * anything outside a conservative allow-list to `_` (same policy as
 * `Auth/Lock.ts`, kept local to avoid coupling `Util` to the auth module).
 *
 * @internal exported for unit testing.
 */
export const sanitizeKey = (key: string): string =>
  key.replace(/[^A-Za-z0-9._-]/g, "_");

/** File-system errors that mean "we cannot lock here at all". */
const UNLOCKABLE_FS_CODES = new Set(["EROFS", "EACCES", "EPERM", "ENOSPC"]);

export interface FileSemaphoreOptions {
  /** Directory in which per-key lockfiles are created. */
  directory: string;
  /**
   * How long (ms) a lockfile may go without an mtime refresh before other
   * processes treat it as stale and steal it. The holder refreshes on a
   * timer, which can be starved for seconds under heavy load (e.g. a full
   * test run saturating every core), so keep this generous.
   * @default 30_000
   */
  stale?: number;
}

export const make = (options: FileSemaphoreOptions): FileSemaphore => {
  const stale = options.stale ?? 30_000;
  // Same-process waiters queue here instead of busy-retrying the lockfile
  // (the lockfile library tracks in-process holders by path and would
  // otherwise fail acquisition with "already being held" until released).
  const inProcess = PartitionedSemaphore.makeUnsafe<string>({ permits: 1 });

  const acquireFileLock = (key: string) => {
    const lockPath = path.join(options.directory, `${sanitizeKey(key)}.lock`);
    return Effect.promise(async (): Promise<() => Promise<void>> => {
      try {
        await fs.mkdir(options.directory, { recursive: true });
        return await lock(lockPath, {
          retries: { retries: 600, minTimeout: 50, maxTimeout: 50 },
          stale,
          realpath: false,
          // The library's default handler throws from a timer callback,
          // which surfaces as an uncaught exception and kills the process.
          // A compromised lock is benign here (worst case two holders race),
          // so log and continue.
          onCompromised: (err) => {
            console.warn(
              `file lock '${lockPath}' compromised (continuing): ${err.message}`,
            );
          },
        });
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== undefined && UNLOCKABLE_FS_CODES.has(code)) {
          // Best-effort: on file systems where the lock directory cannot be
          // created at all (read-only home in containers/CI), run
          // unserialised with a warning instead of failing.
          console.warn(
            `file lock unavailable (${code} at '${lockPath}') — continuing without cross-process locking`,
          );
          return async () => {};
        }
        if (
          err instanceof Error &&
          err.message.includes("already being held")
        ) {
          throw new Error(
            `Timed out waiting for the lock '${lockPath}' — another alchemy ` +
              `process has held it for over ${Math.round((600 * 50) / 1000)}s. If no other alchemy ` +
              `process is running, delete the lock file and retry.`,
            { cause: err },
          );
        }
        throw err;
      }
    });
  };

  return {
    withPermit: (key) => (effect) =>
      inProcess.withPermit(key)(
        Effect.acquireUseRelease(
          acquireFileLock(key),
          () => effect,
          (release) => Effect.promise(() => release().catch(() => {})),
        ),
      ),
  };
};
