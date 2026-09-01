import { rootDir } from "@/Auth/Paths.ts";
import { makeLocalState } from "@/State/LocalState.ts";
import type { ResourceState } from "@/State/ResourceState.ts";
import { localStateKeyFileName } from "@/State/SecretCodec.ts";
import type { PersistedState, StateStoreError } from "@/State/State.ts";
import {
  encodeState,
  REDACTED_MARKER,
  SECRET_MARKER,
} from "@/State/StateEncoding.ts";
import { initialCwd } from "@/Util/Node.ts";
import { PlatformServices } from "@/Util/PlatformServices.ts";
import { describe, expect, it } from "alchemy-test";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";

/**
 * Backwards-compatibility matrix for secret encryption in the LOCAL state
 * store. The invariant under test: upgrading alchemy must never make
 * existing state unreadable, and a read that cannot be decrypted must fail
 * with a typed `StateStoreError` — never a defect, never a silent rewrite.
 *
 * Tests that exercise the auto-generated machine key point `ALCHEMY_HOME`
 * at a scoped temp directory (and are `exclusive`, the env var is
 * process-global) so they never read, create, or delete the developer's
 * real `~/.alchemy/state.key`.
 */

const SECRET = "sk-live-compat-secret";

/** A `ConfigProvider` with NO `ALCHEMY_PASSWORD`, whatever the real env holds. */
const noPassword = ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} }));

const withPassword = (password: string) =>
  ConfigProvider.layer(
    ConfigProvider.fromEnv({ env: { ALCHEMY_PASSWORD: password } }),
  );

const resource = (
  fqn: string,
  props: Record<string, unknown>,
  overrides?: Partial<ResourceState>,
): ResourceState =>
  ({
    kind: "resource",
    resourceType: "Test.Resource",
    namespace: undefined,
    fqn,
    logicalId: fqn,
    instanceId: `instance-${fqn}`,
    providerVersion: 1,
    status: "created",
    downstream: [],
    bindings: [],
    props,
    attr: { url: "https://example.com" },
    ...overrides,
  }) as ResourceState;

const secretOf = (state: PersistedState | undefined) =>
  Redacted.value(
    (
      (state as ResourceState | undefined)?.props as {
        apiKey: Redacted.Redacted<string>;
      }
    ).apiKey,
  );

/** Absolute path of a state file, anchored like `makeLocalState` itself. */
const stateFile = (stack: string, stage: string, name: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    return path.join(
      initialCwd,
      ".alchemy",
      "state",
      stack,
      stage,
      `${name}.json`,
    );
  });

/**
 * The exact bytes every pre-encryption version of alchemy persisted:
 * `encodeState` without a codec IS the legacy writer (plaintext
 * `__redacted__` markers), pretty-printed the way `LocalState.set` does.
 */
const legacyJson = (value: unknown) =>
  JSON.stringify(encodeState(value), null, 2);

const writeLegacyFile = (file: string, value: unknown) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(path.dirname(file), { recursive: true });
    yield* fs.writeFileString(file, legacyJson(value));
  });

/**
 * Point `ALCHEMY_HOME` at a scoped temp directory for the duration of
 * `effect`, so the machine key lives (and dies) there. Returns the temp
 * home so callers can inspect / remove the key file.
 */
const withTempHome = <A, E, R>(
  effect: (home: string) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped({
      prefix: "alchemy-state-key-",
    });
    const previous = process.env.ALCHEMY_HOME;
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        process.env.ALCHEMY_HOME = dir;
      }),
      () =>
        Effect.sync(() => {
          if (previous === undefined) delete process.env.ALCHEMY_HOME;
          else process.env.ALCHEMY_HOME = previous;
        }),
    );
    return yield* effect(dir);
  }).pipe(Effect.scoped);

const keyFileIn = (home: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    return path.join(home, localStateKeyFileName);
  });

describe("secret encryption: local state backwards compatibility", () => {
  it.effect(
    "reads legacy plaintext state on a machine with no key — and never creates one",
    () =>
      withTempHome((home) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const stack = "secret-compat-legacy-read";
          const stage = "test";
          const keyFile = yield* keyFileIn(home);
          expect(rootDir()).toBe(home);

          // The old world: a resource, a replaced resource and a stack output,
          // all with plaintext `__redacted__` markers, written by hand.
          const worker = resource("worker", { apiKey: Redacted.make(SECRET) });
          const replaced = resource(
            "old-worker",
            { apiKey: Redacted.make("sk-old") },
            {
              status: "replaced",
              deleteFirst: false,
              old: resource("old-worker", {
                apiKey: Redacted.make("sk-older"),
              }),
            } as Partial<ResourceState>,
          );
          yield* writeLegacyFile(
            yield* stateFile(stack, stage, "worker"),
            worker,
          );
          yield* writeLegacyFile(
            yield* stateFile(stack, stage, "old-worker"),
            replaced,
          );
          yield* writeLegacyFile(
            yield* stateFile(stack, stage, "__stack_output__"),
            { token: Redacted.make("out-secret"), url: "https://example.com" },
          );

          const store = yield* makeLocalState().pipe(
            Effect.provide(noPassword),
          );

          // Every read path revives the legacy markers into Redacted values.
          expect(
            secretOf(yield* store.get({ stack, stage, fqn: "worker" })),
          ).toBe(SECRET);
          expect([...(yield* store.list({ stack, stage }))].sort()).toEqual([
            "old-worker",
            "worker",
          ]);
          const replacedRows = yield* store.getReplacedResources({
            stack,
            stage,
          });
          expect(replacedRows.map((r) => r.fqn)).toEqual(["old-worker"]);
          expect(secretOf(replacedRows[0]!.old as ResourceState)).toBe(
            "sk-older",
          );
          const output = (yield* store.getOutput({ stack, stage })) as {
            token: Redacted.Redacted<string>;
            url: string;
          };
          expect(Redacted.value(output.token)).toBe("out-secret");
          expect(output.url).toBe("https://example.com");

          // A secret-free write does not need a key either.
          yield* store.set({
            stack,
            stage,
            fqn: "plain",
            value: resource("plain", { name: "no secrets here" }),
          });
          expect(yield* store.get({ stack, stage, fqn: "plain" })).toEqual(
            resource("plain", { name: "no secrets here" }),
          );

          // Nothing above needed the machine key: reading legacy state and
          // writing secret-free state on a fresh machine (a CI runner, a
          // teammate's laptop) never creates `~/.alchemy/state.key`.
          expect(yield* fs.exists(keyFile)).toBe(false);
          // ...and the legacy files were not rewritten by the reads.
          expect(
            yield* fs.readFileString(yield* stateFile(stack, stage, "worker")),
          ).toBe(legacyJson(worker));

          yield* store.deleteStack({ stack });
        }),
      ).pipe(Effect.provide(PlatformServices)),
    { exclusive: true },
  );

  it.effect(
    "encrypted and legacy entries coexist in one stage; a legacy entry migrates on its next write",
    () =>
      withTempHome((home) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const stack = "secret-compat-mixed-stage";
          const stage = "test";
          const keyFile = yield* keyFileIn(home);

          const legacy = resource("legacy", {
            apiKey: Redacted.make("sk-legacy"),
          });
          const legacyFile = yield* stateFile(stack, stage, "legacy");
          yield* writeLegacyFile(legacyFile, legacy);

          const store = yield* makeLocalState().pipe(
            Effect.provide(noPassword),
          );

          // The first secret write mints the machine key and encrypts.
          const fresh = resource("fresh", { apiKey: Redacted.make(SECRET) });
          yield* store.set({ stack, stage, fqn: "fresh", value: fresh });
          expect(yield* fs.exists(keyFile)).toBe(true);
          const freshRaw = yield* fs.readFileString(
            yield* stateFile(stack, stage, "fresh"),
          );
          expect(freshRaw).toContain(SECRET_MARKER);
          expect(freshRaw).not.toContain(SECRET);
          expect(freshRaw).toContain("https://example.com");

          // Both formats read back through the same store...
          expect(
            secretOf(yield* store.get({ stack, stage, fqn: "legacy" })),
          ).toBe("sk-legacy");
          expect(
            secretOf(yield* store.get({ stack, stage, fqn: "fresh" })),
          ).toBe(SECRET);
          expect([...(yield* store.list({ stack, stage }))].sort()).toEqual([
            "fresh",
            "legacy",
          ]);
          // ...and the legacy file is untouched until it is written again.
          expect(yield* fs.readFileString(legacyFile)).toBe(legacyJson(legacy));

          // The next write of the legacy resource (what any deploy does)
          // migrates it to the encrypted envelope, and it still round-trips.
          const revived = (yield* store.get({ stack, stage, fqn: "legacy" }))!;
          yield* store.set({ stack, stage, fqn: "legacy", value: revived });
          const migrated = yield* fs.readFileString(legacyFile);
          expect(migrated).toContain(SECRET_MARKER);
          expect(migrated).not.toContain(REDACTED_MARKER);
          expect(migrated).not.toContain("sk-legacy");
          expect(
            secretOf(yield* store.get({ stack, stage, fqn: "legacy" })),
          ).toBe("sk-legacy");

          yield* store.deleteStack({ stack });
        }),
      ).pipe(Effect.provide(PlatformServices)),
    { exclusive: true },
  );

  it.effect(
    "a lost machine key fails reads with a typed StateStoreError, leaves the file intact, and restoring the key restores reads",
    () =>
      withTempHome((home) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const stack = "secret-compat-lost-key";
          const stage = "test";
          const key = { stack, stage, fqn: "worker" };
          const keyFile = yield* keyFileIn(home);
          const file = yield* stateFile(stack, stage, "worker");

          const writer = yield* makeLocalState().pipe(
            Effect.provide(noPassword),
          );
          yield* writer.set({
            ...key,
            value: resource("worker", { apiKey: Redacted.make(SECRET) }),
          });
          const originalKey = yield* fs.readFileString(keyFile);
          const originalFile = yield* fs.readFileString(file);

          // Simulate a new laptop / wiped ~/.alchemy: the key is gone but the
          // (committed or copied) state directory is still there.
          yield* fs.remove(keyFile);

          // A fresh store resolves a fresh key, which cannot decrypt.
          const reader = yield* makeLocalState().pipe(
            Effect.provide(noPassword),
          );
          const error = yield* reader.get(key).pipe(Effect.flip);
          expect(error._tag).toBe("StateStoreError");
          expect(error.message).toContain("worker");
          expect(error.message).toMatch(/does not match/);
          // The failed read must not have touched the state file — the data
          // is still recoverable once the right key is back.
          expect(yield* fs.readFileString(file)).toBe(originalFile);
          // A replaced-resource scan hits the same undecryptable file and
          // fails the same way rather than silently dropping the row.
          const scanError = yield* reader
            .getReplacedResources({ stack, stage })
            .pipe(Effect.flip);
          expect(scanError._tag).toBe("StateStoreError");

          // Restoring the original key makes the state readable again.
          yield* fs.writeFileString(keyFile, originalKey);
          const restored = yield* makeLocalState().pipe(
            Effect.provide(noPassword),
          );
          expect(secretOf(yield* restored.get(key))).toBe(SECRET);

          yield* restored.deleteStack({ stack });
        }),
      ).pipe(Effect.provide(PlatformServices)),
    { exclusive: true },
  );

  it.effect(
    "concurrent first-time writers converge on a single machine key",
    () =>
      withTempHome((home) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const stack = "secret-compat-key-race";
          const stage = "test";
          const keyFile = yield* keyFileIn(home);
          expect(yield* fs.exists(keyFile)).toBe(false);

          // Two independent stores (two processes, in effect) race to create
          // the key while writing their first secret.
          const stores = yield* Effect.all(
            Array.from({ length: 4 }, () =>
              makeLocalState().pipe(Effect.provide(noPassword)),
            ),
          );
          yield* Effect.all(
            stores.map((store, i) =>
              store.set({
                stack,
                stage,
                fqn: `worker-${i}`,
                value: resource(`worker-${i}`, {
                  apiKey: Redacted.make(`${SECRET}-${i}`),
                }),
              }),
            ),
            { concurrency: "unbounded" },
          );

          const keyHex = (yield* fs.readFileString(keyFile)).trim();
          expect(keyHex).toMatch(/^[0-9a-f]{64}$/);
          // The key is private to the user (mode 0600), whichever writer won.
          const mode = (yield* fs.stat(keyFile)).mode & 0o777;
          expect(mode.toString(8)).toBe("600");

          // Whatever key won, every writer used it: a fresh store reads all.
          const reader = yield* makeLocalState().pipe(
            Effect.provide(noPassword),
          );
          for (let i = 0; i < stores.length; i++) {
            expect(
              secretOf(yield* reader.get({ stack, stage, fqn: `worker-${i}` })),
            ).toBe(`${SECRET}-${i}`);
          }

          yield* reader.deleteStack({ stack });
        }),
      ).pipe(Effect.provide(PlatformServices)),
    { exclusive: true },
  );

  it.effect(
    "a wrong ALCHEMY_PASSWORD fails with a typed StateStoreError, not a defect",
    () =>
      Effect.gen(function* () {
        const stack = "secret-compat-wrong-password";
        const stage = "test";
        const key = { stack, stage, fqn: "worker" };

        const writer = yield* makeLocalState().pipe(
          Effect.provide(withPassword("password-a")),
        );
        yield* writer.set({
          ...key,
          value: resource("worker", { apiKey: Redacted.make(SECRET) }),
        });

        const reader = yield* makeLocalState().pipe(
          Effect.provide(withPassword("password-b")),
        );
        const error: StateStoreError = yield* reader.get(key).pipe(Effect.flip);
        expect(error._tag).toBe("StateStoreError");
        expect(error.message).toMatch(/does not match/);
        expect(error.message).toContain("ALCHEMY_PASSWORD");

        // Secret-free reads in the same stage are unaffected by the key.
        yield* writer.set({
          ...key,
          fqn: "plain",
          value: resource("plain", { name: "public" }),
        });
        expect(yield* reader.get({ ...key, fqn: "plain" })).toEqual(
          resource("plain", { name: "public" }),
        );

        yield* writer.deleteStack({ stack });
      }).pipe(Effect.provide(PlatformServices)),
  );

  it.effect(
    "stack outputs holding secrets are encrypted at rest and revive; legacy plaintext outputs still revive",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const stack = "secret-compat-outputs";
        const stage = "test";
        const store = yield* makeLocalState().pipe(
          Effect.provide(withPassword("password-a")),
        );
        const file = yield* stateFile(stack, stage, "__stack_output__");

        yield* store.setOutput({
          stack,
          stage,
          value: { token: Redacted.make(SECRET), url: "https://example.com" },
        });
        const raw = yield* fs.readFileString(file);
        expect(raw).toContain(SECRET_MARKER);
        expect(raw).not.toContain(SECRET);
        expect(raw).toContain("https://example.com");
        const output = (yield* store.getOutput({ stack, stage })) as {
          token: Redacted.Redacted<string>;
        };
        expect(Redacted.value(output.token)).toBe(SECRET);

        // A pre-encryption output file (plaintext marker) is still readable.
        yield* fs.writeFileString(
          file,
          legacyJson({ token: Redacted.make("legacy-out") }),
        );
        const legacy = (yield* store.getOutput({ stack, stage })) as {
          token: Redacted.Redacted<string>;
        };
        expect(Redacted.value(legacy.token)).toBe("legacy-out");

        yield* store.deleteStack({ stack });
      }).pipe(Effect.provide(PlatformServices)),
  );

  it("an encrypted envelope is a plain single-key object to a pre-encryption reader, with no plaintext anywhere", () => {
    // Pins the forward-compatibility story documented for shared stores: an
    // alchemy version that predates `__secret__` has no reviver for it, so
    // `JSON.parse` hands it the envelope as an ordinary object — never a
    // crash, and never the secret.
    const codec = {
      encrypt: (plaintext: string) =>
        `v1:${Buffer.from(plaintext).toString("base64")}`,
      decrypt: (payload: string) =>
        Buffer.from(payload.slice(3), "base64").toString(),
    };
    const value = resource("worker", {
      apiKey: Redacted.make(SECRET),
      nested: { tokens: [Redacted.make("t-1")] },
    });
    const json = JSON.stringify(encodeState(value, codec));
    expect(json).not.toContain(SECRET);
    expect(json).not.toContain("t-1");
    expect(json).not.toContain(REDACTED_MARKER);

    const legacyView = JSON.parse(json) as {
      props: {
        apiKey: Record<string, unknown>;
        nested: { tokens: Array<Record<string, unknown>> };
      };
    };
    expect(Object.keys(legacyView.props.apiKey)).toEqual([SECRET_MARKER]);
    expect(String(legacyView.props.apiKey[SECRET_MARKER])).toMatch(/^v1:/);
    expect(Object.keys(legacyView.props.nested.tokens[0]!)).toEqual([
      SECRET_MARKER,
    ]);

    // And without a codec the writer is byte-for-byte the legacy writer.
    expect(JSON.stringify(encodeState(value))).toContain(
      `{"${REDACTED_MARKER}":"${SECRET}"}`,
    );
  });
});
