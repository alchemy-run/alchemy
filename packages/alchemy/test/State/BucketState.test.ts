import { describe, expect, it } from "@alchemy.run/test";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { makeBucketState, type BucketObjects } from "@/State/BucketState.ts";

/**
 * Hermetic tests of the bucket store's lease, over an in-memory bucket
 * whose reads and writes each take `latencyMs` of TestClock time.
 */

const LEASE_KEY = "app/dev/__lease__.json";

/**
 * An in-memory bucket. It counts lease reads and records each lease
 * write's TestClock time. Set `latencyMs` to 0 before the test ends: the
 * lease finalizer runs when the test's scope closes, and nothing advances
 * the clock then.
 */
const memoryBucket = () => {
  const objects = new Map<string, { text: string; version: string }>();
  let nextVersion = 0;
  const bucket = {
    latencyMs: 0,
    leaseReads: 0,
    leaseWrites: [] as number[],
    leaseExpiresAt: () => {
      const lease = objects.get(LEASE_KEY);
      return lease === undefined ? undefined : (JSON.parse(lease.text).expiresAt as number);
    },
    objects: undefined as unknown as BucketObjects,
  };
  const latency = Effect.suspend(() =>
    bucket.latencyMs > 0 ? Effect.sleep(bucket.latencyMs) : Effect.void,
  );
  const keysUnder = (prefix: string) =>
    Array.from(objects.keys()).filter((key) => key.startsWith(prefix));
  bucket.objects = {
    listKeys: (prefix) => latency.pipe(Effect.as(keysUnder(prefix))),
    listChildren: (prefix) =>
      latency.pipe(
        Effect.as(
          Array.from(
            new Set(keysUnder(prefix).map((key) => key.slice(prefix.length).split("/")[0]!)),
          ),
        ),
      ),
    read: (key) =>
      latency.pipe(
        Effect.andThen(
          Effect.sync(() => {
            if (key === LEASE_KEY) bucket.leaseReads++;
            return objects.get(key);
          }),
        ),
      ),
    write: (key, text, condition) =>
      latency.pipe(
        Effect.andThen(Clock.currentTimeMillis),
        Effect.map((now) => {
          const existing = objects.get(key);
          if (condition !== undefined) {
            const holds =
              "ifAbsent" in condition
                ? existing === undefined
                : existing?.version === condition.ifVersion;
            if (!holds) return undefined;
          }
          const version = String(++nextVersion);
          objects.set(key, { text, version });
          if (key === LEASE_KEY) bucket.leaseWrites.push(now);
          return version;
        }),
      ),
    delete: (key, ifVersion) =>
      latency.pipe(
        Effect.andThen(
          Effect.sync(() => {
            if (ifVersion === undefined || objects.get(key)?.version === ifVersion) {
              objects.delete(key);
            }
          }),
        ),
      ),
    deleteMany: (keys) =>
      latency.pipe(
        Effect.andThen(
          Effect.sync(() => {
            for (const key of keys) objects.delete(key);
          }),
        ),
      ),
  };
  return bucket;
};

describe("BucketState lease", { tags: ["unit", "local"] }, () => {
  it.effect("keeps the lease through a burst of state operations on a slow bucket", () =>
    Effect.gen(function* () {
      const bucket = memoryBucket();
      bucket.latencyMs = 350;
      const state = yield* makeBucketState({
        id: "memory",
        label: "Memory",
        objects: Effect.succeed(bucket.objects),
      });

      // One plan's worth of reads arriving together, as when a deploy loads
      // its state. At 350 ms per read, 300 lease checks in a row would take
      // far longer than the 60-second lease.
      const burst = yield* Effect.forEach(
        Array.from({ length: 300 }, (_, i) => i),
        (i) => state.get({ stack: "app", stage: "dev", fqn: `resource-${i}` }).pipe(Effect.result),
        { concurrency: "unbounded" },
      ).pipe(Effect.forkChild);
      yield* TestClock.adjust("90 seconds");
      const results = yield* Fiber.join(burst);
      const now = yield* Clock.currentTimeMillis;
      bucket.latencyMs = 0;

      expect(results.filter((result) => result._tag === "Failure")).toHaveLength(0);
      expect(bucket.leaseReads).toBe(1);
      // Acquired at 0s, then refreshed every 20 seconds.
      expect(bucket.leaseWrites.length).toBeGreaterThanOrEqual(4);
      expect(bucket.leaseExpiresAt()!).toBeGreaterThan(now);
    }),
  );
});
