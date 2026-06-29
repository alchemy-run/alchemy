import * as secretsmanager from "@distilled.cloud/aws/secrets-manager";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Layer from "effect/Layer";
import { isFunction } from "../Lambda/Function.ts";
import { ListSecrets } from "./ListSecrets.ts";

export const ListSecretsHttp = Layer.effect(
  ListSecrets,
  Effect.gen(function* () {
    const listSecrets = yield* secretsmanager.listSecrets;

    return Effect.fn(function* () {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isFunction(host)) {
          yield* host.bind`Allow(${host}, AWS.SecretsManager.ListSecrets())`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: ["secretsmanager:ListSecrets"],
                Resource: ["*"],
              },
            ],
          });
        }
      }
      return Effect.fn("AWS.SecretsManager.ListSecrets")(function* (
        request: secretsmanager.ListSecretsRequest = {},
      ) {
        return yield* listSecrets(request);
      });
    });
  }),
);
