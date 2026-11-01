import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";

/**
 * One lock per key, for a read-modify-write of a shared object in a deploy, where resources
 * with no dependency between them run concurrently. It only covers this process: another
 * client's write between the read and the write can still be lost.
 */
export const makeKeyedLock = () => {
  const locks = new Map<string, Semaphore.Semaphore>();
  return (key: string) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
      Effect.suspend(() => {
        let lock = locks.get(key);
        if (lock === undefined) {
          lock = Semaphore.makeUnsafe(1);
          locks.set(key, lock);
        }
        return lock.withPermits(1)(effect);
      });
};
