import * as FileSemaphore from "@/Util/FileSemaphore.ts";
import { PlatformServices } from "@/Util/PlatformServices.ts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

describe("sanitizeKey", () => {
  it("leaves conventional keys untouched", () => {
    expect(FileSemaphore.sanitizeKey("abc123-account_id.v2")).toBe(
      "abc123-account_id.v2",
    );
  });

  it("collapses characters invalid in file names", () => {
    const sanitized = FileSemaphore.sanitizeKey("${ACCOUNT:-default}/id");
    expect(sanitized).toBe("__ACCOUNT_-default__id");
    expect(sanitized).not.toMatch(/[<>:"/\\|?*${}]/);
  });
});

describe("FileSemaphore", () => {
  const withTempDir = <A, E, R>(
    body: (dir: string) => Effect.Effect<A, E, R>,
  ) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({
        prefix: "alchemy-file-semaphore-",
      });
      return yield* body(dir);
    }).pipe(Effect.scoped, Effect.provide(PlatformServices));

  it.live("runs the effect and creates/releases the lockfile", () =>
    withTempDir((dir) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const semaphore = FileSemaphore.make({ directory: dir });
        const result = yield* semaphore.withPermit("key-a")(
          Effect.gen(function* () {
            // The lockfile (a directory) exists while the permit is held.
            expect(yield* fs.exists(`${dir}/key-a.lock.lock`)).toBe(true);
            return "ran";
          }),
        );
        expect(result).toBe("ran");
        expect(yield* fs.exists(`${dir}/key-a.lock.lock`)).toBe(false);
      }),
    ),
  );

  it.live("serialises same-key critical sections in-process", () =>
    withTempDir((dir) =>
      Effect.gen(function* () {
        const semaphore = FileSemaphore.make({ directory: dir });
        const order: number[] = [];
        const critical = (i: number) =>
          semaphore.withPermit("same-key")(
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
      }),
    ),
  );

  it.live("allows different keys to run concurrently", () =>
    withTempDir((dir) =>
      Effect.gen(function* () {
        const semaphore = FileSemaphore.make({ directory: dir });
        const events: string[] = [];
        const critical = (key: string) =>
          semaphore.withPermit(key)(
            Effect.gen(function* () {
              events.push(`${key}:start`);
              yield* Effect.sleep("100 millis");
              events.push(`${key}:end`);
            }),
          );
        yield* Effect.all([critical("a"), critical("b")], {
          concurrency: "unbounded",
        });
        // Both keys started before either finished — no cross-key blocking.
        expect(events.slice(0, 2).sort()).toEqual(["a:start", "b:start"]);
      }),
    ),
  );

  it.live("keys with invalid file name characters still lock", () =>
    withTempDir((dir) =>
      Effect.gen(function* () {
        const semaphore = FileSemaphore.make({ directory: dir });
        const result = yield* semaphore.withPermit("${ACCOUNT:-default}/id")(
          Effect.succeed("ran"),
        );
        expect(result).toBe("ran");
      }),
    ),
  );
});
