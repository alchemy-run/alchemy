import { rootDir } from "@/Auth/Paths.ts";
import { makeLocalState } from "@/State/LocalState.ts";
import type { ResourceState } from "@/State/ResourceState.ts";
import {
  localStateKeyFileName,
  makeSecretCodec,
  resolveSecretCodec,
} from "@/State/SecretCodec.ts";
import {
  encodeState,
  makeStateReviver,
  reviveState,
  reviveStateRecursive,
  REDACTED_MARKER,
  SECRET_MARKER,
} from "@/State/StateEncoding.ts";
import { PlatformServices } from "@/Util/PlatformServices.ts";
import { describe, expect, it } from "alchemy-test";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";

const PASSWORD = Redacted.make("correct horse battery staple");
const codec = makeSecretCodec(PASSWORD);

const sampleState = {
  props: {
    name: "my-worker",
    apiKey: Redacted.make("sk-live-super-secret"),
    nested: { tokens: [Redacted.make("t-1"), Redacted.make("t-2")] },
  },
  attr: { url: "https://example.com" },
};

describe("StateEncoding secrets", () => {
  it("round-trips Redacted values without a codec (legacy plaintext marker)", () => {
    const json = JSON.stringify(encodeState(sampleState));
    expect(json).toContain(REDACTED_MARKER);
    expect(json).toContain("sk-live-super-secret");
    const revived = JSON.parse(json, reviveState);
    expect(Redacted.value(revived.props.apiKey)).toBe("sk-live-super-secret");
    expect(Redacted.value(revived.props.nested.tokens[1])).toBe("t-2");
  });

  it("encrypts Redacted values with a codec — plaintext never in the output", () => {
    const json = JSON.stringify(encodeState(sampleState, codec));
    expect(json).toContain(SECRET_MARKER);
    expect(json).not.toContain(REDACTED_MARKER);
    expect(json).not.toContain("sk-live-super-secret");
    expect(json).not.toContain("t-1");
    // Non-secret values stay introspectable.
    expect(json).toContain("my-worker");
    expect(json).toContain("https://example.com");

    const revived = JSON.parse(json, makeStateReviver(codec));
    expect(Redacted.value(revived.props.apiKey)).toBe("sk-live-super-secret");
    expect(Redacted.value(revived.props.nested.tokens[0])).toBe("t-1");
  });

  it("reviveStateRecursive decrypts __secret__ envelopes", () => {
    const encoded = encodeState(sampleState, codec);
    // Simulate the HTTP store: value arrives pre-parsed, not as a JSON string.
    const roundTripped = JSON.parse(JSON.stringify(encoded));
    const revived = reviveStateRecursive(roundTripped, codec) as any;
    expect(Redacted.value(revived.props.apiKey)).toBe("sk-live-super-secret");
  });

  it("still revives legacy plaintext __redacted__ markers when a codec is active", () => {
    const legacyJson = JSON.stringify(encodeState(sampleState));
    const revived = JSON.parse(legacyJson, makeStateReviver(codec));
    expect(Redacted.value(revived.props.apiKey)).toBe("sk-live-super-secret");
  });

  it("reviveStateRecursive revives legacy plaintext markers when a codec is active", () => {
    // The HTTP store path: legacy state arrives pre-parsed with plaintext
    // markers written by an older version.
    const legacy = JSON.parse(JSON.stringify(encodeState(sampleState)));
    const revived = reviveStateRecursive(legacy, codec) as any;
    expect(Redacted.value(revived.props.apiKey)).toBe("sk-live-super-secret");
    expect(Redacted.value(revived.props.nested.tokens[1])).toBe("t-2");
  });

  it("fails with an actionable error when encrypted state is read without a password", () => {
    const json = JSON.stringify(encodeState(sampleState, codec));
    expect(() => JSON.parse(json, reviveState)).toThrow(/ALCHEMY_PASSWORD/);
  });

  it("fails with an actionable error on a wrong password", () => {
    const json = JSON.stringify(encodeState(sampleState, codec));
    const wrong = makeSecretCodec(Redacted.make("not the password"));
    expect(() => JSON.parse(json, makeStateReviver(wrong))).toThrow(
      /does not match/,
    );
  });

  it("only decrypts exact single-key __secret__ envelopes", () => {
    // A user object that merely CONTAINS the marker key alongside other
    // fields is data, not an envelope — it must pass through untouched
    // instead of failing the whole read.
    const json = JSON.stringify({
      props: { [SECRET_MARKER]: "just a value", keep: true },
    });
    const revived = JSON.parse(json, makeStateReviver(codec));
    expect(revived.props[SECRET_MARKER]).toBe("just a value");
    expect(revived.props.keep).toBe(true);
    const recursive = reviveStateRecursive(JSON.parse(json), codec) as any;
    expect(recursive.props[SECRET_MARKER]).toBe("just a value");
  });

  it("rejects truncated envelopes as malformed, not with raw crypto errors", () => {
    const json = JSON.stringify({ apiKey: { [SECRET_MARKER]: "v1:AAAA" } });
    expect(() => JSON.parse(json, makeStateReviver(codec))).toThrow(
      /truncated/,
    );
  });

  it.effect(
    "resolveSecretCodec is undefined when ALCHEMY_PASSWORD is unset",
    () =>
      Effect.gen(function* () {
        const resolved = yield* resolveSecretCodec;
        expect(resolved).toBeUndefined();
      }).pipe(
        Effect.provide(
          ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })),
        ),
      ),
  );

  it.effect(
    "resolveSecretCodec builds a working codec from ALCHEMY_PASSWORD",
    () =>
      Effect.gen(function* () {
        const resolved = yield* resolveSecretCodec;
        expect(resolved).toBeDefined();
        const ciphertext = resolved!.encrypt("hello");
        expect(ciphertext).not.toContain("hello");
        // Interoperates with a codec built directly from the same password.
        expect(codec.decrypt(ciphertext)).toBe("hello");
      }).pipe(
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnv({
              env: { ALCHEMY_PASSWORD: Redacted.value(PASSWORD) },
            }),
          ),
        ),
      ),
  );

  it.effect(
    "LocalState writes encrypted secrets to disk and revives them on read",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const state = yield* makeLocalState();
        const stack = "state-encoding-secret-codec-test";
        const key = { stack, stage: "test", fqn: "worker" };
        const value: ResourceState = {
          kind: "resource",
          resourceType: "Test.Resource",
          namespace: undefined,
          fqn: "worker",
          logicalId: "worker",
          instanceId: "i-1",
          providerVersion: 1,
          status: "created",
          downstream: [],
          bindings: [],
          props: { apiKey: Redacted.make("sk-live-super-secret") },
          attr: { url: "https://example.com" },
        };
        yield* state.set({ ...key, value });

        // The raw file on disk must not contain the plaintext secret.
        const file = path.join(
          process.cwd(),
          ".alchemy",
          "state",
          stack,
          "test",
          "worker.json",
        );
        const raw = yield* fs.readFileString(file);
        expect(raw).toContain(SECRET_MARKER);
        expect(raw).not.toContain("sk-live-super-secret");
        // Non-secret state stays introspectable.
        expect(raw).toContain("https://example.com");

        // Reading through the store decrypts back into a Redacted.
        const revived = (yield* state.get(key)) as ResourceState;
        expect(
          Redacted.value(
            (revived.props as { apiKey: Redacted.Redacted<string> }).apiKey,
          ),
        ).toBe("sk-live-super-secret");

        yield* state.deleteStack({ stack });
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            ConfigProvider.layer(
              ConfigProvider.fromEnv({
                env: { ALCHEMY_PASSWORD: Redacted.value(PASSWORD) },
              }),
            ),
            PlatformServices,
          ),
        ),
      ),
  );

  it.effect(
    "migrates legacy unencrypted local state: reads plaintext markers, re-writes encrypted",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const stack = "state-encoding-migration-test";
        const key = { stack, stage: "test", fqn: "worker" };
        const file = path.join(
          process.cwd(),
          ".alchemy",
          "state",
          stack,
          "test",
          "worker.json",
        );
        const value: ResourceState = {
          kind: "resource",
          resourceType: "Test.Resource",
          namespace: undefined,
          fqn: "worker",
          logicalId: "worker",
          instanceId: "i-1",
          providerVersion: 1,
          status: "created",
          downstream: [],
          bindings: [],
          props: { apiKey: Redacted.make("sk-live-super-secret") },
          attr: { url: "https://example.com" },
        };

        // 1. The old world: hand-write the exact plaintext-marker JSON
        //    every pre-encryption version of alchemy persisted (encodeState
        //    without a codec is that legacy writer).
        yield* fs.makeDirectory(path.dirname(file), { recursive: true });
        yield* fs.writeFileString(
          file,
          JSON.stringify(encodeState(value), null, 2),
        );
        const legacyRaw = yield* fs.readFileString(file);
        expect(legacyRaw).toContain(REDACTED_MARKER);
        expect(legacyRaw).toContain("sk-live-super-secret");

        // 2. The user sets ALCHEMY_PASSWORD: the legacy plaintext state
        //    must still read (backwards compatibility).
        const store = yield* makeLocalState().pipe(
          Effect.provide(
            ConfigProvider.layer(
              ConfigProvider.fromEnv({
                env: { ALCHEMY_PASSWORD: Redacted.value(PASSWORD) },
              }),
            ),
          ),
        );
        const revived = (yield* store.get(key)) as ResourceState;
        expect(
          Redacted.value(
            (revived.props as { apiKey: Redacted.Redacted<string> }).apiKey,
          ),
        ).toBe("sk-live-super-secret");

        // 3. The next write (what any subsequent deploy does) migrates the
        //    file to the encrypted envelope.
        yield* store.set({ ...key, value: revived });
        const migratedRaw = yield* fs.readFileString(file);
        expect(migratedRaw).toContain(SECRET_MARKER);
        expect(migratedRaw).not.toContain(REDACTED_MARKER);
        expect(migratedRaw).not.toContain("sk-live-super-secret");

        // 4. The migrated state round-trips.
        const migrated = (yield* store.get(key)) as ResourceState;
        expect(
          Redacted.value(
            (migrated.props as { apiKey: Redacted.Redacted<string> }).apiKey,
          ),
        ).toBe("sk-live-super-secret");

        yield* store.deleteStack({ stack });
      }).pipe(Effect.provide(PlatformServices)),
  );

  it.effect(
    "encrypts local state by default via the auto-generated ~/.alchemy/state.key",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const stack = "state-encoding-keyfile-default-test";
        const key = { stack, stage: "test", fqn: "worker" };
        const value: ResourceState = {
          kind: "resource",
          resourceType: "Test.Resource",
          namespace: undefined,
          fqn: "worker",
          logicalId: "worker",
          instanceId: "i-1",
          providerVersion: 1,
          status: "created",
          downstream: [],
          bindings: [],
          props: { apiKey: Redacted.make("sk-live-super-secret") },
          attr: { url: "https://example.com" },
        };

        // No ALCHEMY_PASSWORD anywhere in scope — the store must fall
        // back to (and auto-create) the machine key.
        const store = yield* makeLocalState().pipe(
          Effect.provide(
            ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })),
          ),
        );
        yield* store.set({ ...key, value });

        const keyFile = path.join(rootDir(), localStateKeyFileName);
        expect(yield* fs.exists(keyFile)).toBe(true);

        const raw = yield* fs.readFileString(
          path.join(
            process.cwd(),
            ".alchemy",
            "state",
            stack,
            "test",
            "worker.json",
          ),
        );
        expect(raw).toContain(SECRET_MARKER);
        expect(raw).not.toContain("sk-live-super-secret");

        const revived = (yield* store.get(key)) as ResourceState;
        expect(
          Redacted.value(
            (revived.props as { apiKey: Redacted.Redacted<string> }).apiKey,
          ),
        ).toBe("sk-live-super-secret");

        yield* store.deleteStack({ stack });
      }).pipe(Effect.provide(PlatformServices)),
  );
});
