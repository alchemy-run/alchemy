import * as comprehendmedical from "@distilled.cloud/aws/comprehendmedical";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import { DetectPHI } from "./DetectPHI.ts";

export const DetectPHIHttp = Layer.effect(
  DetectPHI,
  Effect.gen(function* () {
    const detectPHI = yield* comprehendmedical.detectPHI;

    return Effect.fn(function* () {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, AWS.ComprehendMedical.DetectPHI())`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: ["comprehendmedical:DetectPHI"],
                // comprehendmedical:DetectPHI has no resource-level IAM
                Resource: ["*"],
              },
            ],
          });
        }
      }
      return Effect.fn("AWS.ComprehendMedical.DetectPHI")(function* (
        request: comprehendmedical.DetectPHIRequest,
      ) {
        return yield* detectPHI(request);
      });
    });
  }),
);
