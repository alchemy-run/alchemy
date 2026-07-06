import { sanitizeLockKey, withLock } from "@/Auth/Lock.ts";
import { rootDir } from "@/Auth/Profile.ts";
import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

// Pin the `CI` config so these tests exercise the intended `withLock`
// path regardless of where they run: real locking is CI-skipped, so a
// CI runner would otherwise silently test the no-op path (and the
// skip test would vacuously pass locally).
const withEnv = (env: Record<string, unknown>) =>
  Effect.provide(
    Layer.mergeAll(
      ConfigProvider.layer(ConfigProvider.fromUnknown(env)),
      NodeServices.layer,
    ),
  );

describe("sanitizeLockKey", () => {
  it("leaves conventional keys untouched", () => {
    expect(sanitizeLockKey("default-Cloudflare")).toBe("default-Cloudflare");
    expect(sanitizeLockKey("my_profile.v2-AWS")).toBe("my_profile.v2-AWS");
  });

  it("neutralises unexpanded shell placeholders", () => {
    // Seen verbatim in production: EINVAL mkdir
    // '...\${ALCHEMY_PROFILE:-default}-Cloudflare.lock.lock' on Windows,
    // where `:`/`$`/`{`/`}` are invalid in file names.
    const sanitized = sanitizeLockKey("${ALCHEMY_PROFILE:-default}-Cloudflare");
    expect(sanitized).toBe("__ALCHEMY_PROFILE_-default_-Cloudflare");
    expect(sanitized).not.toMatch(/[<>:"/\\|?*${}]/);
  });

  it("replaces path separators so keys cannot escape the lock dir", () => {
    expect(sanitizeLockKey("../../etc/passwd")).toBe(".._.._etc_passwd");
  });
});

describe("withLock", () => {
  it.live(
    "acquires and releases a lock whose key contains characters invalid in file names",
    () =>
      Effect.gen(function* () {
        // Regression for the production EINVAL: this key is unusable as a
        // raw Windows file name without sanitisation.
        const result = yield* withLock(
          "${ALCHEMY_PROFILE:-default}-LockTest",
          Effect.succeed("ran"),
        );
        expect(result).toBe("ran");
      }).pipe(withEnv({ CI: false })),
  );

  it.live("serialises same-key critical sections in-process", () =>
    Effect.gen(function* () {
      const order: number[] = [];
      const critical = (i: number) =>
        withLock(
          "lock-test-serialise",
          Effect.gen(function* () {
            order.push(i);
            yield* Effect.sleep("50 millis");
            order.push(i);
          }),
        );
      yield* Effect.all([critical(1), critical(2)], {
        concurrency: "unbounded",
      });
      // Each critical section's two entries must be adjacent — no
      // interleaving between holders.
      expect(order.slice(0, 2)).toEqual([order[0], order[0]]);
      expect(order.slice(2)).toEqual([order[2], order[2]]);
    }).pipe(withEnv({ CI: false })),
  );

  it.live("skips locking entirely in CI", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const key = "lock-test-ci-skip";
      // The lockfile library materialises `<lockPath>.lock` on disk.
      const lockArtifact = path.join(rootDir, "lock", `${key}.lock.lock`);
      const result = yield* withLock(
        key,
        Effect.gen(function* () {
          // No lock artifact exists while the critical section runs —
          // in CI the lock is never acquired (runner file systems can
          // be read-only), not just released quickly.
          expect(yield* fs.exists(lockArtifact)).toBe(false);
          return "ran";
        }),
      );
      expect(result).toBe("ran");
    }).pipe(withEnv({ CI: true })),
  );
});
