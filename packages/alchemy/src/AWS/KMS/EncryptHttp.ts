import * as kms from "@distilled.cloud/aws/kms";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isFunction } from "../Lambda/Function.ts";
import type { AliasName } from "./Alias.ts";
import { Encrypt, type EncryptRequest } from "./Encrypt.ts";
import type { Key } from "./Key.ts";
import { keyLabel, keyPolicyStatement } from "./KeyBinding.ts";

export const EncryptHttp = Layer.effect(
  Encrypt,
  Effect.gen(function* () {
    const encrypt = yield* kms.encrypt;

    return Effect.fn(function* (key: Key | AliasName) {
      const KeyId =
        typeof key === "string" ? Effect.succeed(key) : yield* key.keyId;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isFunction(host)) {
          yield* host.bind`Allow(${host}, AWS.KMS.Encrypt(${key}))`({
            policyStatements: [keyPolicyStatement("kms:Encrypt", key)],
          });
        }
      }
      return Effect.fn(`AWS.KMS.Encrypt(${keyLabel(key)})`)(function* (
        request: EncryptRequest,
      ) {
        const keyId = yield* KeyId;
        return yield* encrypt({
          ...request,
          KeyId: keyId,
        });
      });
    });
  }),
);
