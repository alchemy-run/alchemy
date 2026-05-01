import * as Effect from "effect/Effect";
import * as fs from "node:fs/promises";
import * as path from "pathe";
import lockfile from "proper-lockfile";
import { rootDir } from "./Profile.ts";

const lockDir = path.join(rootDir, "lock");

/**
 * Serialise execution of `effect` so no two callers ever run inside the
 * critical section concurrently for the same `key`, both within this
 * process and across other processes on the same machine.
 *
 * Uses `proper-lockfile` for both: it tracks in-process holders by path
 * (so same-process callers wait via `retries`) and uses an OS file lock
 * for cross-process coordination, with stale-lock detection at 60s.
 */
export const withLock = <A, E, R>(
  key: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> => {
  const lockPath = path.join(lockDir, `${key}.lock`);
  return Effect.acquireUseRelease(
    Effect.promise(async () => {
      await fs.mkdir(lockDir, { recursive: true });
      await fs.writeFile(lockPath, "", { flag: "a" });
      return await lockfile.lock(lockPath, {
        retries: { retries: 600, minTimeout: 50, maxTimeout: 50 },
        stale: 5_000,
      });
    }),
    () => effect,
    (release) => Effect.promise(() => release().catch(() => {})),
  );
};
