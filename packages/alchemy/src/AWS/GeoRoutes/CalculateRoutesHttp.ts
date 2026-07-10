import * as geoRoutes from "@distilled.cloud/aws/geo-routes";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import { CalculateRoutes } from "./CalculateRoutes.ts";

export const CalculateRoutesHttp = Layer.effect(
  CalculateRoutes,
  Effect.gen(function* () {
    const calculateRoutes = yield* geoRoutes.calculateRoutes;

    return Effect.fn(function* () {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, AWS.GeoRoutes.CalculateRoutes())`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: ["geo-routes:CalculateRoutes"],
                // geo-routes is a standalone, account-wide pay-per-call API
                // scoped through the singleton `provider/default`; the route
                // calculation itself has no per-resource ARN.
                Resource: ["*"],
              },
            ],
          });
        }
      }
      return Effect.fn("AWS.GeoRoutes.CalculateRoutes")(function* (
        request: geoRoutes.CalculateRoutesRequest,
      ) {
        return yield* calculateRoutes(request);
      });
    });
  }),
);
