import { describe, expect, it } from "@alchemy.run/test";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import { makeLocalState } from "@/State/LocalState.ts";
import { passphraseEncryption } from "@/State/PassphraseEncryption.ts";
import { encodeState } from "@/State/StateEncoding.ts";
import { makeSealingCodec, SEALED_PREFIX, StateEncryption } from "@/State/StateEncryption.ts";
import { initialCwd } from "@/Util/Node.ts";
import { PlatformServices } from "@/Util/PlatformServices";

const scope = { stack: "app", stage: "prod" };
const record = { status: "created", attr: { password: Redacted.make("hunter2"), name: "db" } };

/** A sealing codec over the passphrase layer. */
const codecWith = Effect.fn(
  function* (_options: Parameters<typeof passphraseEncryption>[0]) {
    return makeSealingCodec(yield* StateEncryption);
  },
  (effect, options) => Effect.provide(effect, passphraseEncryption(options)),
);

describe("passphraseEncryption", { tags: ["unit", "local"] }, () => {
  it.effect("seals with one passphrase and opens with the same one in another process", () =>
    Effect.gen(function* () {
      const passphrase = Redacted.make("correct horse battery staple");
      const text = yield* (yield* codecWith({ passphrase })).encode(scope, record);
      expect(text.startsWith(`${SEALED_PREFIX}passphrase:`)).toBe(true);
      expect(text).not.toContain("hunter2");

      // A fresh layer, as a later deploy would build: its own salt.
      const read = yield* (yield* codecWith({ passphrase })).decode<typeof record>(
        scope,
        text,
        "record",
      );
      expect(Redacted.value(read.attr.password)).toBe("hunter2");
    }),
  );

  it.effect("refuses the wrong passphrase, and a record moved to another stage", () =>
    Effect.gen(function* () {
      const text = yield* (yield* codecWith({ passphrase: Redacted.make("right") })).encode(
        scope,
        record,
      );
      const wrong = yield* (yield* codecWith({ passphrase: Redacted.make("wrong") }))
        .decode(scope, text, "record")
        .pipe(Effect.flip);
      expect(wrong.message).toContain("wrong passphrase");

      const moved = yield* (yield* codecWith({ passphrase: Redacted.make("right") }))
        .decode({ stack: "app", stage: "dev" }, text, "record")
        .pipe(Effect.flip);
      expect(moved.message).toContain("wrong passphrase");
    }),
  );

  it.effect("reads ALCHEMY_STATE_PASSPHRASE by default, and says so when it's missing", () =>
    Effect.gen(function* () {
      const fromEnv = yield* codecWith({}).pipe(
        Effect.flatMap((codec) => codec.encode(scope, record)),
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({ ALCHEMY_STATE_PASSPHRASE: "env-pass" }),
          ),
        ),
      );
      expect(fromEnv.startsWith(`${SEALED_PREFIX}passphrase:`)).toBe(true);

      const missing = yield* Effect.exit(
        codecWith({}).pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({})))),
      );
      expect(Exit.isFailure(missing)).toBe(true);
      expect(String(Exit.isFailure(missing) ? missing.cause : "")).toContain(
        "ALCHEMY_STATE_PASSPHRASE",
      );
    }),
  );

  it.effect("encrypts local state, and decrypts it again with disable", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const passphrase = Redacted.make("local-state-pass");
      const local = { stack: "passphrase-encryption-test", stage: "test" };
      const file = path.join(initialCwd, ".alchemy", "state", local.stack, local.stage, "Db.json");
      const store = (disable?: boolean) =>
        makeLocalState().pipe(Effect.provide(passphraseEncryption({ passphrase, disable })));

      yield* (yield* store()).set({ ...local, fqn: "Db", value: record as never });
      const sealed = yield* fs.readFileString(file);
      expect(sealed.startsWith(`${SEALED_PREFIX}passphrase:`)).toBe(true);
      expect(sealed).not.toContain("hunter2");

      const off = yield* store(true);
      yield* off.get({ ...local, fqn: "Db" });
      expect(yield* fs.readFileString(file)).toBe(JSON.stringify(encodeState(record), null, 2));
      yield* off.deleteStack({ stack: local.stack });
    }).pipe(Effect.provide(PlatformServices)),
  );
});
