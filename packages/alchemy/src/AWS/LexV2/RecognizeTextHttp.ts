import * as lexr from "@distilled.cloud/aws/lex-runtime-v2";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import type { BotAlias } from "./BotAlias.ts";
import { RecognizeText, type RecognizeTextRequest } from "./RecognizeText.ts";

export const RecognizeTextHttp = Layer.effect(
  RecognizeText,
  Effect.gen(function* () {
    const recognizeText = yield* lexr.recognizeText;

    return Effect.fn(function* (alias: BotAlias) {
      const BotId = yield* alias.botId;
      const BotAliasId = yield* alias.botAliasId;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, AWS.LexV2.RecognizeText(${alias}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: ["lex:RecognizeText"],
                Resource: [alias.botAliasArn],
              },
            ],
          });
        }
      }
      return Effect.fn(`AWS.LexV2.RecognizeText(${alias.LogicalId})`)(
        function* (request: RecognizeTextRequest) {
          const botId = yield* BotId;
          const botAliasId = yield* BotAliasId;
          return yield* recognizeText({ ...request, botId, botAliasId });
        },
      );
    });
  }),
);
