import * as geoMaps from "@distilled.cloud/aws/geo-maps";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import { GetStaticMap } from "./GetStaticMap.ts";

export const GetStaticMapHttp = Layer.effect(
  GetStaticMap,
  Effect.gen(function* () {
    const getStaticMap = yield* geoMaps.getStaticMap;

    return Effect.fn(function* () {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, AWS.GeoMaps.GetStaticMap())`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: ["geo-maps:GetStaticMap"],
                // geo-maps is a standalone, account-wide pay-per-call API
                // scoped through the singleton `provider/default`; the render
                // itself has no per-resource ARN.
                Resource: ["*"],
              },
            ],
          });
        }
      }
      return Effect.fn("AWS.GeoMaps.GetStaticMap")(function* (
        request: geoMaps.GetStaticMapRequest,
      ) {
        return yield* getStaticMap(request);
      });
    });
  }),
);
