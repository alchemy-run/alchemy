import * as pricing from "@distilled.cloud/aws/pricing";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import {
  DescribeServices,
  type DescribeServicesRequest,
} from "./DescribeServices.ts";
import { withPricingRegion } from "./internal.ts";

export const DescribeServicesHttp = Layer.effect(
  DescribeServices,
  Effect.gen(function* () {
    // Capture the client with the region pinned to us-east-1 — the Price
    // List Query API is not served from most regions.
    const describeServices = yield* withPricingRegion(pricing.describeServices);

    return Effect.fn(function* () {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, AWS.Pricing.DescribeServices())`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: ["pricing:DescribeServices"],
                // pricing:DescribeServices has no resource-level IAM
                Resource: ["*"],
              },
            ],
          });
        }
      }
      return Effect.fn("AWS.Pricing.DescribeServices")(function* (
        request?: DescribeServicesRequest,
      ) {
        return yield* describeServices(request ?? {});
      });
    });
  }),
);
