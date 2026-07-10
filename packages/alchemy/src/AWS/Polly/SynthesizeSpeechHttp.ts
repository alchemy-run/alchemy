import * as polly from "@distilled.cloud/aws/polly";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isFunction } from "../Lambda/Function.ts";
import { SynthesizeSpeech } from "./SynthesizeSpeech.ts";

export const SynthesizeSpeechHttp = Layer.effect(
  SynthesizeSpeech,
  Effect.gen(function* () {
    const synthesizeSpeech = yield* polly.synthesizeSpeech;

    return Effect.fn(function* () {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isFunction(host)) {
          yield* host.bind`Allow(${host}, AWS.Polly.SynthesizeSpeech())`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: ["polly:SynthesizeSpeech"],
                // polly:SynthesizeSpeech only supports resource-level IAM
                // for lexicons; the synthesis call itself is account-wide.
                Resource: ["*"],
              },
            ],
          });
        }
      }
      return Effect.fn("AWS.Polly.SynthesizeSpeech")(function* (
        request: polly.SynthesizeSpeechInput,
      ) {
        return yield* synthesizeSpeech(request);
      });
    });
  }),
);
