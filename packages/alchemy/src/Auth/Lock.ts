import { lock } from "@alchemy.run/node-utils/lockfile";
import * as Effect from "effect/Effect";
import * as fs from "node:fs/promises";
import * as path from "pathe";
import { rootDir } from "./Profile.ts";

/**
 * Serialise execution of `effect` so no two callers ever run inside the
 * critical section concurrently for the same `key`, both within this
 * process and across other processes on the same machine.
 *
 * Uses `@alchemy.run/node-utils` lockfile for both: it tracks in-process
 * holders by path (so same-process callers wait via `retries`) and uses
 * an OS file lock for cross-process coordination, with stale-lock
 * detection at 60s.
 */
export const withLock = <A, E, R>(
  key: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> => {
  // Computed lazily (not at module-eval time) so that the
  // `Profile -> AuthProvider -> Lock -> Profile` import cycle never reads
  // `rootDir` before `Profile.ts` has finished initialising it.
  const lockDir = path.join(rootDir, "lock");
  const lockPath = path.join(lockDir, `${key}.lock`);
  return Effect.acquireUseRelease(
    Effect.promise(async () => {
      await fs.mkdir(lockDir, { recursive: true });
      return await lock(lockPath, {
        retries: { retries: 600, minTimeout: 50, maxTimeout: 50 },
        // The holder refreshes the lockfile mtime on a timer. Under heavy
        // load (e.g. a full test run saturating every core) that timer can
        // be starved for several seconds, so keep the stale threshold well
        // above any realistic starvation pause.
        stale: 30_000,
        realpath: false,
        // The library's default handler throws from a timer callback,
        // which surfaces as an uncaught exception and kills the process.
        // A compromised auth lock is benign here (worst case two refreshes
        // race), so log and continue.
        onCompromised: (err) => {
          console.warn(`auth lock compromised (continuing): ${err.message}`);
        },
      });
    }),
    () => effect,
    (release) => Effect.promise(() => release().catch(() => {})),
  );
};
