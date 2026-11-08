import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { describe, expect, test } from "@alchemy.run/test";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { makeBucketState, type BucketObjects } from "@/State/BucketState.ts";
import { StateStoreError } from "@/State/State.ts";
import { encodeState, reviveState } from "@/State/StateEncoding.ts";
import {
  makeSealingCodec,
  plainCodec,
  SEALED_PREFIX,
  SEALED_RECORD_MARKER,
  type SealingScope,
  StateEncryption,
  type StateEncryptionService,
  stateCodec,
} from "@/State/StateEncryption.ts";

/**
 * A keyring that wraps data keys under one in-memory master key, binding
 * each to its stage the way KMS's encryption context does, and counts calls.
 */
const memoryKeyring = (options: { failGenerate?: number; id?: string } = {}) => {
  const master = randomBytes(32);
  const calls = { generate: 0, unwrap: 0 };
  let failures = options.failGenerate ?? 0;
  const aad = (scope: SealingScope) => Buffer.from(`${scope.stack}/${scope.stage}`);
  const keyring: StateEncryptionService = {
    id: options.id ?? "memory",
    generate: (scope) =>
      Effect.suspend(() => {
        calls.generate++;
        if (failures > 0) {
          failures--;
          return Effect.fail(new StateStoreError({ message: "keyring unavailable" }));
        }
        const plaintext = randomBytes(32);
        const iv = randomBytes(12);
        const cipher = createCipheriv("aes-256-gcm", master, iv).setAAD(aad(scope));
        const wrapped = Buffer.concat([
          iv,
          cipher.update(plaintext),
          cipher.final(),
          cipher.getAuthTag(),
        ]).toString("base64");
        return Effect.succeed({ plaintext: new Uint8Array(plaintext), wrapped });
      }),
    unwrap: (wrapped, scope) =>
      Effect.try({
        try: () => {
          calls.unwrap++;
          const bytes = Buffer.from(wrapped, "base64");
          const decipher = createDecipheriv("aes-256-gcm", master, bytes.subarray(0, 12))
            .setAAD(aad(scope))
            .setAuthTag(bytes.subarray(bytes.length - 16));
          return new Uint8Array(
            Buffer.concat([
              decipher.update(bytes.subarray(12, bytes.length - 16)),
              decipher.final(),
            ]),
          );
        },
        catch: () => new StateStoreError({ message: "wrong stage or key" }),
      }),
  };
  return { keyring, calls };
};

const scope = { stack: "app", stage: "prod" };

const record = {
  status: "created",
  props: { name: "db", password: Redacted.make("hunter2") },
  attr: {
    connection: Redacted.make({ url: "postgres://u:hunter2@db", rotated: new Date(0) }),
    createdAt: new Date(1_000),
    timeout: Duration.seconds(30),
    tokens: [Redacted.make("token-1"), "public"],
  },
};

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);

describe("sealing codec", { tags: ["unit", "local"] }, () => {
  test("seals secrets, leaves the rest readable, and fails to parse as plain JSON", async () => {
    const { keyring } = memoryKeyring();
    const codec = makeSealingCodec(keyring);
    const text = await run(codec.encode(scope, record));

    expect(text.startsWith(SEALED_PREFIX)).toBe(true);
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("token-1");
    expect(text).not.toContain("__redacted__");
    expect(text).toContain('"name":"db"');
    expect(text).toContain('"public"');
    // A version from before sealing fails here instead of reading the
    // envelope as the secret.
    expect(() => JSON.parse(text, reviveState)).toThrow();

    const decoded = await run(codec.decode<typeof record>(scope, text, "record"));
    expect(Redacted.value(decoded.props.password)).toBe("hunter2");
    expect(Redacted.value(decoded.attr.connection)).toEqual({
      url: "postgres://u:hunter2@db",
      rotated: new Date(0),
    });
    expect(decoded.attr.createdAt).toEqual(new Date(1_000));
    expect(Duration.toSeconds(decoded.attr.timeout)).toBe(30);
    expect(Redacted.value(decoded.attr.tokens[0] as Redacted.Redacted<string>)).toBe("token-1");
    expect(decoded.attr.tokens[1]).toBe("public");
  });

  test("mints one data key per stage, and unwraps each stored key once", async () => {
    const { keyring, calls } = memoryKeyring();
    const writer = makeSealingCodec(keyring);
    const texts = await run(
      Effect.forEach([1, 2, 3], () => writer.encode(scope, record), { concurrency: 3 }),
    );
    const other = await run(writer.encode({ stack: "app", stage: "dev" }, record));
    expect(calls.generate).toBe(2);
    // One wrapped key heads every record of the stage.
    expect(new Set(texts.map((text) => text.split("\n")[0])).size).toBe(1);
    expect(other.split("\n")[0]).not.toBe(texts[0]!.split("\n")[0]);

    // The writer opens its own records without the keyring.
    await run(Effect.forEach(texts, (text) => writer.decode(scope, text, "record")));
    expect(calls.unwrap).toBe(0);

    const reader = makeSealingCodec(keyring);
    await run(Effect.forEach(texts, (text) => reader.decode(scope, text, "record")));
    expect(calls.unwrap).toBe(1);
  });

  test("binds a record to its stage", async () => {
    const { keyring } = memoryKeyring();
    const codec = makeSealingCodec(keyring);
    const text = await run(codec.encode(scope, record));
    const exit = await Effect.runPromiseExit(
      makeSealingCodec(keyring).decode({ stack: "app", stage: "dev" }, text, "record"),
    );
    expect(Exit.isFailure(exit)).toBe(true);
  });

  test("writes a record without secrets as plain JSON", async () => {
    const { keyring, calls } = memoryKeyring();
    const value = { status: "created", attr: { arn: "arn:aws:sqs:::q" } };
    const text = await run(makeSealingCodec(keyring).encode(scope, value, 2));
    expect(text).toBe(JSON.stringify(value, null, 2));
    expect(calls.generate).toBe(0);
  });

  test("reads records written in plaintext, and reports them as unsealed", async () => {
    const { keyring } = memoryKeyring();
    const codec = makeSealingCodec(keyring);
    const legacy = JSON.stringify(encodeState(record));
    expect(codec.unsealed(legacy)).toBe(true);
    expect(codec.unsealed(JSON.stringify({ attr: { arn: "a" } }))).toBe(false);

    const decoded = await run(codec.decode<typeof record>(scope, legacy, "record"));
    expect(Redacted.value(decoded.props.password)).toBe("hunter2");
    const sealed = await run(codec.encode(scope, decoded));
    expect(codec.unsealed(sealed)).toBe(false);
  });

  test("opens a sealed record into the plain JSON older versions read", async () => {
    const { keyring } = memoryKeyring();
    const codec = makeSealingCodec(keyring);
    const sealed = await run(codec.encode(scope, record));
    const opened = await run(codec.open(scope, sealed));
    expect(opened).toBe(JSON.stringify(encodeState(record)));
  });

  test("a failed data key request is retried, not cached", async () => {
    const { keyring, calls } = memoryKeyring({ failGenerate: 1 });
    const codec = makeSealingCodec(keyring);
    const first = await Effect.runPromiseExit(codec.encode(scope, record));
    expect(Exit.isFailure(first)).toBe(true);
    await run(codec.encode(scope, record));
    expect(calls.generate).toBe(2);
  });

  test("a tampered secret fails to decode", async () => {
    const { keyring } = memoryKeyring();
    const codec = makeSealingCodec(keyring);
    const text = await run(codec.encode(scope, { secret: Redacted.make("hunter2") }));
    const tampered = text.replace(
      /"__sealed__":"(.)/,
      (_match, first: string) => `"__sealed__":"${first === "A" ? "B" : "A"}`,
    );
    const exit = await Effect.runPromiseExit(codec.decode(scope, tampered, "record"));
    expect(Exit.isFailure(exit)).toBe(true);
  });

  test("the plain codec refuses sealed records", async () => {
    const { keyring } = memoryKeyring();
    const text = await run(makeSealingCodec(keyring).encode(scope, record));
    const exit = await Effect.runPromiseExit(plainCodec.decode(scope, text, "record"));
    expect(String(Exit.isFailure(exit) ? exit.cause : "")).toContain(
      "encrypted with 'memory', and this state store has no StateEncryption",
    );
  });
});

describe("sealing codec, JSON form", { tags: ["unit", "local"] }, () => {
  test("seals secrets in place, keeping a record's top-level fields", async () => {
    const { keyring } = memoryKeyring();
    const codec = makeSealingCodec(keyring);
    const json = (await run(codec.encodeJson(scope, record))) as Record<string, unknown>;
    // A JSON store can still filter on status.
    expect(json.status).toBe("created");
    expect(json[SEALED_RECORD_MARKER]).toMatchObject({ by: "memory" });
    expect(JSON.stringify(json)).not.toContain("hunter2");

    const decoded = await run(
      makeSealingCodec(keyring).decodeJson<typeof record>(scope, json, "record"),
    );
    expect(Redacted.value(decoded.props.password)).toBe("hunter2");
    expect(decoded.attr.createdAt).toEqual(new Date(1_000));
    expect(SEALED_RECORD_MARKER in decoded).toBe(false);
  });

  test("seals a value that isn't a record, such as a stack output array", async () => {
    const { keyring } = memoryKeyring();
    const codec = makeSealingCodec(keyring);
    const output = [Redacted.make("hunter2"), "public"];
    const json = await run(codec.encodeJson(scope, output));
    expect(JSON.stringify(json)).not.toContain("hunter2");
    const decoded = await run(codec.decodeJson<typeof output>(scope, json, "output"));
    expect(Redacted.value(decoded[0] as Redacted.Redacted<string>)).toBe("hunter2");
    expect(decoded[1]).toBe("public");
  });

  test("leaves a value without secrets as encodeState writes it", async () => {
    const { keyring, calls } = memoryKeyring();
    const value = { status: "created", attr: { at: new Date(0) } };
    expect(await run(makeSealingCodec(keyring).encodeJson(scope, value))).toEqual(
      encodeState(value),
    );
    expect(calls.generate).toBe(0);
  });
});

describe("StateEncryption service", { tags: ["unit", "local"] }, () => {
  test("stores use the StateEncryption in context, and plaintext without one", async () => {
    const { keyring } = memoryKeyring();
    const sealed = await run(
      stateCodec.pipe(
        Effect.flatMap((codec) => codec.encode(scope, record)),
        Effect.provide(Layer.succeed(StateEncryption, keyring)),
      ),
    );
    expect(sealed.startsWith(`${SEALED_PREFIX}memory:`)).toBe(true);
    const plain = await run(
      stateCodec.pipe(Effect.flatMap((codec) => codec.encode(scope, record))),
    );
    expect(plain).toBe(JSON.stringify(encodeState(record)));
  });

  test("refuses a record another implementation sealed", async () => {
    const text = await run(makeSealingCodec(memoryKeyring().keyring).encode(scope, record));
    const other = makeSealingCodec(memoryKeyring({ id: "other" }).keyring);
    const exit = await Effect.runPromiseExit(other.decode(scope, text, "record"));
    expect(String(Exit.isFailure(exit) ? exit.cause : "")).toContain(
      "encrypted with 'memory', but this state store encrypts with 'other'",
    );
  });
});

/** A bucket held in memory, with versioned conditional writes. */
const memoryObjects = () => {
  const objects = new Map<string, { text: string; version: string }>();
  let next = 0;
  const bucket: BucketObjects = {
    listKeys: (prefix) =>
      Effect.sync(() => [...objects.keys()].filter((key) => key.startsWith(prefix))),
    listChildren: () => Effect.succeed([]),
    read: (key) => Effect.sync(() => objects.get(key)),
    write: (key, text, condition) =>
      Effect.sync(() => {
        const existing = objects.get(key);
        if (condition && "ifAbsent" in condition && existing) return undefined;
        if (condition && "ifVersion" in condition && existing?.version !== condition.ifVersion) {
          return undefined;
        }
        const version = String(++next);
        objects.set(key, { text, version });
        return version;
      }),
    delete: (key, ifVersion) =>
      Effect.sync(() => {
        if (ifVersion === undefined || objects.get(key)?.version === ifVersion) objects.delete(key);
      }),
    deleteMany: (keys) => Effect.sync(() => keys.forEach((key) => objects.delete(key))),
  };
  return { objects, bucket };
};

describe("BucketState with a sealing codec", { tags: ["unit", "local"] }, () => {
  test("seals what it writes, and a plaintext record the first time it reads it", async () => {
    const { objects, bucket } = memoryObjects();
    const { keyring } = memoryKeyring();
    const key = "app/prod/Database.json";
    objects.set(key, { text: JSON.stringify(encodeState(record), null, 2), version: "0" });

    const value = await Effect.runPromise(
      Effect.gen(function* () {
        const state = yield* makeBucketState({
          id: "memory",
          label: "memory",
          objects: Effect.succeed(bucket),
          codec: makeSealingCodec(keyring),
        });
        const read = yield* state.get({ ...scope, fqn: "Database" });
        yield* state.set({
          ...scope,
          fqn: "Cache",
          value: { status: "created", attr: { token: Redacted.make("t") } } as never,
        });
        return read;
      }).pipe(Effect.scoped, Effect.provide(SecureRandom.layerWebCrypto)),
    );

    expect(Redacted.value((value as unknown as typeof record).props.password)).toBe("hunter2");
    expect(objects.get(key)?.text.startsWith(SEALED_PREFIX)).toBe(true);
    expect(objects.get(key)?.text).not.toContain("hunter2");
    expect(objects.get("app/prod/Cache.json")?.text.startsWith(SEALED_PREFIX)).toBe(true);
  });
});
