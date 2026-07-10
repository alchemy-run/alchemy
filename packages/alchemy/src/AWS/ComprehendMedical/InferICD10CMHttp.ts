import * as comprehendmedical from "@distilled.cloud/aws/comprehendmedical";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import { InferICD10CM } from "./InferICD10CM.ts";

export const InferICD10CMHttp = Layer.effect(
  InferICD10CM,
  Effect.gen(function* () {
    const inferICD10CM = yield* comprehendmedical.inferICD10CM;

    return Effect.fn(function* () {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, AWS.ComprehendMedical.InferICD10CM())`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: ["comprehendmedical:InferICD10CM"],
                  // comprehendmedical:InferICD10CM has no resource-level IAM
                  Resource: ["*"],
                },
              ],
            },
          );
        }
      }
      return Effect.fn("AWS.ComprehendMedical.InferICD10CM")(function* (
        request: comprehendmedical.InferICD10CMRequest,
      ) {
        return yield* inferICD10CM(request);
      });
    });
  }),
);
