import * as pricing from "@distilled.cloud/aws/pricing";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import {
  GetAttributeValues,
  type GetAttributeValuesRequest,
} from "./GetAttributeValues.ts";
import { withPricingRegion } from "./internal.ts";

export const GetAttributeValuesHttp = Layer.effect(
  GetAttributeValues,
  Effect.gen(function* () {
    // Capture the client with the region pinned to us-east-1 — the Price
    // List Query API is not served from most regions.
    const getAttributeValues = yield* withPricingRegion(
      pricing.getAttributeValues,
    );

    return Effect.fn(function* () {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, AWS.Pricing.GetAttributeValues())`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: ["pricing:GetAttributeValues"],
                // pricing:GetAttributeValues has no resource-level IAM
                Resource: ["*"],
              },
            ],
          });
        }
      }
      return Effect.fn("AWS.Pricing.GetAttributeValues")(function* (
        request: GetAttributeValuesRequest,
      ) {
        return yield* getAttributeValues(request);
      });
    });
  }),
);
