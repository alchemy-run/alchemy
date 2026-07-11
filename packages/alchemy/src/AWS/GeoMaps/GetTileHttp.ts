import * as geoMaps from "@distilled.cloud/aws/geo-maps";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import { GetTile } from "./GetTile.ts";

export const GetTileHttp = Layer.effect(
  GetTile,
  Effect.gen(function* () {
    const getTile = yield* geoMaps.getTile;

    return Effect.fn(function* () {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, AWS.GeoMaps.GetTile())`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: ["geo-maps:GetTile"],
                // geo-maps is a standalone, account-wide pay-per-call API
                // scoped through the singleton `provider/default`; the tile
                // fetch itself has no per-resource ARN.
                Resource: ["*"],
              },
            ],
          });
        }
      }
      return Effect.fn("AWS.GeoMaps.GetTile")(function* (
        request: geoMaps.GetTileRequest,
      ) {
        return yield* getTile(request);
      });
    });
  }),
);
