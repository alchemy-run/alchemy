import * as kms from "@distilled.cloud/aws/kms";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isFunction } from "../Lambda/Function.ts";
import type { AliasName } from "./Alias.ts";
import {
  GenerateDataKey,
  type GenerateDataKeyRequest,
} from "./GenerateDataKey.ts";
import type { Key } from "./Key.ts";
import { keyLabel, keyPolicyStatement } from "./KeyBinding.ts";

export const GenerateDataKeyHttp = Layer.effect(
  GenerateDataKey,
  Effect.gen(function* () {
    const generateDataKey = yield* kms.generateDataKey;

    return Effect.fn(function* (key: Key | AliasName) {
      const KeyId =
        typeof key === "string" ? Effect.succeed(key) : yield* key.keyId;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isFunction(host)) {
          yield* host.bind`Allow(${host}, AWS.KMS.GenerateDataKey(${key}))`({
            policyStatements: [keyPolicyStatement("kms:GenerateDataKey", key)],
          });
        }
      }
      return Effect.fn(`AWS.KMS.GenerateDataKey(${keyLabel(key)})`)(function* (
        request: GenerateDataKeyRequest,
      ) {
        const keyId = yield* KeyId;
        return yield* generateDataKey({
          ...request,
          KeyId: keyId,
        });
      });
    });
  }),
);
