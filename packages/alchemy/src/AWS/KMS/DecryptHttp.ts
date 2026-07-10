import * as kms from "@distilled.cloud/aws/kms";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isFunction } from "../Lambda/Function.ts";
import type { AliasName } from "./Alias.ts";
import { Decrypt, type DecryptRequest } from "./Decrypt.ts";
import type { Key } from "./Key.ts";
import { keyLabel, keyPolicyStatement } from "./KeyBinding.ts";

export const DecryptHttp = Layer.effect(
  Decrypt,
  Effect.gen(function* () {
    const decrypt = yield* kms.decrypt;

    return Effect.fn(function* (key: Key | AliasName) {
      const KeyId =
        typeof key === "string" ? Effect.succeed(key) : yield* key.keyId;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isFunction(host)) {
          yield* host.bind`Allow(${host}, AWS.KMS.Decrypt(${key}))`({
            policyStatements: [keyPolicyStatement("kms:Decrypt", key)],
          });
        }
      }
      return Effect.fn(`AWS.KMS.Decrypt(${keyLabel(key)})`)(function* (
        request: DecryptRequest,
      ) {
        const keyId = yield* KeyId;
        return yield* decrypt({
          ...request,
          KeyId: keyId,
        });
      });
    });
  }),
);
