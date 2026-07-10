import * as comprehendmedical from "@distilled.cloud/aws/comprehendmedical";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import { DetectEntitiesV2 } from "./DetectEntitiesV2.ts";

export const DetectEntitiesV2Http = Layer.effect(
  DetectEntitiesV2,
  Effect.gen(function* () {
    const detectEntitiesV2 = yield* comprehendmedical.detectEntitiesV2;

    return Effect.fn(function* () {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, AWS.ComprehendMedical.DetectEntitiesV2())`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: ["comprehendmedical:DetectEntitiesV2"],
                  // comprehendmedical:DetectEntitiesV2 has no resource-level IAM
                  Resource: ["*"],
                },
              ],
            },
          );
        }
      }
      return Effect.fn("AWS.ComprehendMedical.DetectEntitiesV2")(function* (
        request: comprehendmedical.DetectEntitiesV2Request,
      ) {
        return yield* detectEntitiesV2(request);
      });
    });
  }),
);
