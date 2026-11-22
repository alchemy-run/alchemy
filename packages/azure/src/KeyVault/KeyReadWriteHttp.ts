import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { Key } from "./Key.ts";
import { makeKeyReadClient } from "./KeyReadHttp.ts";
import { KeyReadWrite, type ReadWriteKeyClient } from "./KeyReadWrite.ts";
import { makeKeyWriteClient } from "./KeyWriteHttp.ts";

/**
 * Implementation of {@link KeyReadWrite} over the distilled `keyvault-keys`
 * data plane: the {@link KeyRead} and {@link KeyWrite} clients together.
 * Assigns their custom roles on the key.
 *
 * @layer
 * @provides Azure.KeyVault.KeyReadWrite
 */
export const KeyReadWriteHttp = Layer.effect(
  KeyReadWrite,
  Effect.gen(function* () {
    const read = yield* makeKeyReadClient;
    const write = yield* makeKeyWriteClient;
    return Effect.fn(function* (key: Key) {
      const reader = yield* read(key);
      const writer = yield* write(key);
      return { ...reader, ...writer } satisfies ReadWriteKeyClient;
    });
  }),
);
