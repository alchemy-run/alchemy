import * as geoPlaces from "@distilled.cloud/aws/geo-places";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import { Geocode } from "./Geocode.ts";

export const GeocodeHttp = Layer.effect(
  Geocode,
  Effect.gen(function* () {
    const geocode = yield* geoPlaces.geocode;

    return Effect.fn(function* () {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, AWS.GeoPlaces.Geocode())`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: ["geo-places:Geocode"],
                // geo-places is a standalone, account-wide pay-per-call API
                // scoped through the singleton `provider/default`; the geocode
                // call itself has no per-resource ARN.
                Resource: ["*"],
              },
            ],
          });
        }
      }
      return Effect.fn("AWS.GeoPlaces.Geocode")(function* (
        request: geoPlaces.GeocodeRequest,
      ) {
        return yield* geocode(request);
      });
    });
  }),
);
