import * as geoRoutes from "@distilled.cloud/aws/geo-routes";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import { CalculateIsolines } from "./CalculateIsolines.ts";

export const CalculateIsolinesHttp = Layer.effect(
  CalculateIsolines,
  Effect.gen(function* () {
    const calculateIsolines = yield* geoRoutes.calculateIsolines;

    return Effect.fn(function* () {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, AWS.GeoRoutes.CalculateIsolines())`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: ["geo-routes:CalculateIsolines"],
                // geo-routes is a standalone, account-wide pay-per-call API
                // scoped through the singleton `provider/default`; the isoline
                // calculation itself has no per-resource ARN.
                Resource: ["*"],
              },
            ],
          });
        }
      }
      return Effect.fn("AWS.GeoRoutes.CalculateIsolines")(function* (
        request: geoRoutes.CalculateIsolinesRequest,
      ) {
        return yield* calculateIsolines(request);
      });
    });
  }),
);
