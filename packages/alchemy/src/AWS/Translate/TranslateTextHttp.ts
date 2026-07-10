import * as translate from "@distilled.cloud/aws/translate";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import { TranslateText } from "./TranslateText.ts";

export const TranslateTextHttp = Layer.effect(
  TranslateText,
  Effect.gen(function* () {
    const translateText = yield* translate.translateText;

    return Effect.fn(function* () {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, AWS.Translate.TranslateText())`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: ["translate:TranslateText"],
                // translate:TranslateText has no resource-level IAM
                Resource: ["*"],
              },
            ],
          });
        }
      }
      return Effect.fn("AWS.Translate.TranslateText")(function* (
        request: translate.TranslateTextRequest,
      ) {
        return yield* translateText(request);
      });
    });
  }),
);
