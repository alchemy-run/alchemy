// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
/**
 * Adapted from Miniflare's
 * `test/plugins/secret-store/persistence.spec.ts` (#16611). The race cases
 * swap the directory around the first `node:fs.openSync` of the store.
 */
import * as NodeFs from "node:fs";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { vi } from "vitest";
import { ensureSecretsStoreDirectory } from "../../bindings/secrets-store/SecretsStorePersistence.ts";

const modeOf = (path: string) =>
  FileSystem.FileSystem.use((fs) => fs.stat(path)).pipe(Effect.map((info) => info.mode & 0o777));

const openHook = vi.hoisted(() => ({
  before: undefined as (() => void) | undefined,
  after: undefined as (() => void) | undefined,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const openSync: typeof actual.openSync = (...args) => {
    const { before, after } = openHook;
    openHook.before = openHook.after = undefined;
    before?.();
    const fd = actual.openSync(...args);
    after?.();
    return fd;
  };
  return { ...actual, default: { ...actual, openSync }, openSync };
});

/** Run `ensureSecretsStoreDirectory` with hooks around its `openSync` of the store. */
const ensureWithOpenHook = (store: string, hooks: { before?: () => void; after?: () => void }) =>
  Effect.suspend(() => {
    Object.assign(openHook, hooks);
    return ensureSecretsStoreDirectory(store);
  }).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        openHook.before = openHook.after = undefined;
      }),
    ),
  );

// POSIX permission assertions do not describe Windows' inherited ACLs.
describe.runIf(process.platform !== "win32")("Secrets Store persistence boundary", () => {
  it.effect("resolves a configured parent alias without restricting it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      const parent = path.join(root, "parent");
      const alias = path.join(root, "alias");
      yield* fs.makeDirectory(parent);
      yield* fs.chmod(parent, 0o755);
      yield* fs.symlink(parent, alias);
      const secured = yield* ensureSecretsStoreDirectory(path.join(alias, "secrets-store"));
      expect(secured).toBe(path.join(yield* fs.realPath(parent), "secrets-store"));
      expect(yield* modeOf(secured)).toBe(0o700);
      expect(yield* modeOf(parent)).toBe(0o755);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  for (const dangling of [false, true]) {
    it.effect(`rejects a symlink without changing its target (dangling: ${dangling})`, () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped();
        const target = path.join(root, "target");
        const store = path.join(root, "secrets-store");
        if (!dangling) {
          yield* fs.makeDirectory(target);
          yield* fs.chmod(target, 0o755);
        }
        yield* fs.symlink(target, store);
        const error = yield* Effect.flip(ensureSecretsStoreDirectory(store));
        expect(error.message).toContain(
          "The Secrets Store directory must not be a symlink or file.",
        );
        if (!dangling) {
          expect(yield* modeOf(target)).toBe(0o755);
        } else {
          expect(yield* fs.exists(target)).toBe(false);
        }
      }).pipe(Effect.provide(NodeServices.layer)),
    );
  }

  it.effect("rejects a file without changing its permissions", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      const store = path.join(root, "secrets-store");
      yield* fs.writeFileString(store, "dummy-value");
      yield* fs.chmod(store, 0o644);
      const error = yield* Effect.flip(ensureSecretsStoreDirectory(store));
      expect(error.message).toContain("Unable to secure Secrets Store");
      expect(yield* modeOf(store)).toBe(0o644);
      expect(yield* fs.readFileString(store)).toBe("dummy-value");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("checks ownership before changing permissions", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      const store = path.join(root, "secrets-store");
      yield* fs.makeDirectory(store);
      yield* fs.chmod(store, 0o755);
      const owner = Option.getOrElse((yield* fs.stat(store)).uid, () => 0);
      // Simulate a different effective UID without chown or privileged processes.
      const uid = vi.spyOn(process, "geteuid").mockReturnValue(owner + 1);
      try {
        const error = yield* Effect.flip(ensureSecretsStoreDirectory(store));
        expect(error.message).toContain(
          "The Secrets Store directory must be owned by the current user.",
        );
        expect(yield* modeOf(store)).toBe(0o755);
      } finally {
        uid.mockRestore();
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("does not follow a symlink substituted before open", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      const store = path.join(root, "secrets-store");
      const target = path.join(root, "target");
      yield* fs.makeDirectory(store);
      yield* fs.makeDirectory(target);
      yield* fs.chmod(target, 0o755);
      const error = yield* Effect.flip(
        ensureWithOpenHook(store, {
          before: () => {
            NodeFs.renameSync(store, path.join(root, "original"));
            NodeFs.symlinkSync(target, store);
          },
        }),
      );
      expect(error.message).toContain("Unable to secure Secrets Store");
      expect(yield* modeOf(target)).toBe(0o755);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects a directory replaced after open", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      const store = path.join(root, "secrets-store");
      const original = path.join(root, "original");
      yield* fs.makeDirectory(store);
      yield* fs.chmod(store, 0o755);
      const error = yield* Effect.flip(
        ensureWithOpenHook(store, {
          after: () => {
            NodeFs.renameSync(store, original);
            NodeFs.mkdirSync(store);
          },
        }),
      );
      expect(error.message).toContain(
        "The Secrets Store directory could not be secured or was replaced.",
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
