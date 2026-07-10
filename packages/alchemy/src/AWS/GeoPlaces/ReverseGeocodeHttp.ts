import * as geoPlaces from "@distilled.cloud/aws/geo-places";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import { ReverseGeocode } from "./ReverseGeocode.ts";

export const ReverseGeocodeHttp = Layer.effect(
  ReverseGeocode,
  Effect.gen(function* () {
    const reverseGeocode = yield* geoPlaces.reverseGeocode;

    return Effect.fn(function* () {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, AWS.GeoPlaces.ReverseGeocode())`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: ["geo-places:ReverseGeocode"],
                // geo-places is a standalone, account-wide pay-per-call API
                // scoped through the singleton `provider/default`; the call
                // itself has no per-resource ARN.
                Resource: ["*"],
              },
            ],
          });
        }
      }
      return Effect.fn("AWS.GeoPlaces.ReverseGeocode")(function* (
        request: geoPlaces.ReverseGeocodeRequest,
      ) {
        return yield* reverseGeocode(request);
      });
    });
  }),
);
