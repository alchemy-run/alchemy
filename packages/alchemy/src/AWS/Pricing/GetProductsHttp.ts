import * as pricing from "@distilled.cloud/aws/pricing";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import { GetProducts, type GetProductsRequest } from "./GetProducts.ts";
import { withPricingRegion } from "./internal.ts";

export const GetProductsHttp = Layer.effect(
  GetProducts,
  Effect.gen(function* () {
    // Capture the client with the region pinned to us-east-1 — the Price
    // List Query API is not served from most regions.
    const getProducts = yield* withPricingRegion(pricing.getProducts);

    return Effect.fn(function* () {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, AWS.Pricing.GetProducts())`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: ["pricing:GetProducts"],
                // pricing:GetProducts has no resource-level IAM
                Resource: ["*"],
              },
            ],
          });
        }
      }
      return Effect.fn("AWS.Pricing.GetProducts")(function* (
        request: GetProductsRequest,
      ) {
        return yield* getProducts(request);
      });
    });
  }),
);
