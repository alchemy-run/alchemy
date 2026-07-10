import * as geoPlaces from "@distilled.cloud/aws/geo-places";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import { SearchText } from "./SearchText.ts";

export const SearchTextHttp = Layer.effect(
  SearchText,
  Effect.gen(function* () {
    const searchText = yield* geoPlaces.searchText;

    return Effect.fn(function* () {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, AWS.GeoPlaces.SearchText())`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: ["geo-places:SearchText"],
                // geo-places is a standalone, account-wide pay-per-call API
                // scoped through the singleton `provider/default`; the search
                // call itself has no per-resource ARN.
                Resource: ["*"],
              },
            ],
          });
        }
      }
      return Effect.fn("AWS.GeoPlaces.SearchText")(function* (
        request: geoPlaces.SearchTextRequest,
      ) {
        return yield* searchText(request);
      });
    });
  }),
);
