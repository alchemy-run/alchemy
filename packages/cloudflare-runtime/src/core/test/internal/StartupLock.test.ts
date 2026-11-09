// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
/**
 * Adapted from Miniflare's startup lock tests
 * (`workers-sdk/packages/miniflare/test/shared/persist-root-lock.spec.ts`).
 */
import * as ChildProcess from "node:child_process";
import { once } from "node:events";
import * as NodePath from "node:path";
import { pathToFileURL } from "node:url";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import {
  canonicalizeDirectory,
  LOCK_NAME,
  LOCK_STALE_MS,
  withStartupLock,
} from "../../internal/StartupLock.ts";

const LOCK_MODULE = pathToFileURL(
  NodePath.resolve(import.meta.dirname, "../../internal/StartupLock.ts"),
).href;

/**
 * Waits for the "go" file, then holds the lock for 75 ms, logging when it
 * enters and leaves.
 */
const LOCK_CHILD_SCRIPT = `
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";

const { withStartupLock } = await import(process.env.LOCK_MODULE);
const root = process.env.LOCK_ROOT;
const id = process.env.LOCK_CHILD_ID;
await fs.writeFile(path.join(root, "ready-" + id), "");
while (true) {
  try {
    await fs.access(path.join(root, "go"));
    break;
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
await Effect.runPromise(
  withStartupLock(
    root,
    Effect.promise(async () => {
      const events = path.join(root, "events");
      await fs.appendFile(events, "start:" + id + "\\n");
      await new Promise((resolve) => setTimeout(resolve, 75));
      await fs.appendFile(events, "end:" + id + "\\n");
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);
`;

describe("startup lock", () => {
  it.live(
    "serializes callbacks across processes and removes its lock",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "startup-lock-" });
        const childCount = 5;
        const children = Array.from({ length: childCount }, (_, i) =>
          ChildProcess.spawn(process.execPath, ["--input-type=module", "-e", LOCK_CHILD_SCRIPT], {
            // Resolve `effect` and the platform from this package.
            cwd: NodePath.resolve(import.meta.dirname, "../../../.."),
            stdio: ["ignore", "ignore", "inherit"],
            env: {
              ...process.env,
              LOCK_MODULE,
              LOCK_ROOT: root,
              LOCK_CHILD_ID: String(i),
            },
          }),
        );
        const exits = children.map((child) => once(child, "exit"));

        while (
          (yield* fs.readDirectory(root)).filter((entry) => entry.startsWith("ready-")).length <
          childCount
        ) {
          yield* Effect.sleep("5 millis");
        }
        yield* fs.writeFileString(path.join(root, "go"), "");

        for (const [code] of yield* Effect.promise(() => Promise.all(exits))) {
          expect(code).toBe(0);
        }
        const events = (yield* fs.readFileString(path.join(root, "events"))).trim().split("\n");
        expect(events).toHaveLength(childCount * 2);
        for (let i = 0; i < events.length; i += 2) {
          expect(events[i]).toMatch(/^start:/);
          expect(events[i + 1]).toBe(events[i].replace("start:", "end:"));
        }
        expect(yield* fs.exists(path.join(root, LOCK_NAME))).toBe(false);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    { timeout: 60_000 },
  );

  it.live("serializes callbacks within one process", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "startup-lock-" });
      const events: Array<string> = [];
      yield* Effect.forEach(
        [0, 1, 2, 3, 4],
        (id) =>
          withStartupLock(
            root,
            Effect.gen(function* () {
              events.push(`start:${id}`);
              yield* Effect.sleep("20 millis");
              events.push(`end:${id}`);
            }),
          ),
        { concurrency: "unbounded" },
      );
      for (let i = 0; i < events.length; i += 2) {
        expect(events[i + 1]).toBe(events[i].replace("start:", "end:"));
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("recovers stale locks", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "startup-lock-" });
      const lockPath = path.join(root, LOCK_NAME);
      const stale = new Date(Date.now() - 2 * LOCK_STALE_MS);
      yield* fs.writeFileString(lockPath, "");
      yield* fs.utimes(lockPath, stale, stale);

      let called = false;
      yield* withStartupLock(
        root,
        Effect.sync(() => {
          called = true;
        }),
      );

      expect(called).toBe(true);
      expect(yield* fs.exists(lockPath)).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live.runIf(process.platform !== "win32")("canonicalizes symlink aliases", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const parent = yield* fs.makeTempDirectoryScoped({ prefix: "startup-lock-" });
      const root = path.join(parent, "root");
      const alias = path.join(parent, "alias");
      yield* fs.makeDirectory(root);
      yield* fs.symlink(root, alias);
      expect(yield* canonicalizeDirectory(alias)).toBe(yield* canonicalizeDirectory(root));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
