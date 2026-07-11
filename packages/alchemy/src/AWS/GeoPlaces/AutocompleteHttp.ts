import * as geoPlaces from "@distilled.cloud/aws/geo-places";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import { Autocomplete } from "./Autocomplete.ts";

export const AutocompleteHttp = Layer.effect(
  Autocomplete,
  Effect.gen(function* () {
    const autocomplete = yield* geoPlaces.autocomplete;

    return Effect.fn(function* () {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, AWS.GeoPlaces.Autocomplete())`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: ["geo-places:Autocomplete"],
                // geo-places is a standalone, account-wide pay-per-call API
                // scoped through the singleton `provider/default`; the
                // autocomplete call itself has no per-resource ARN.
                Resource: ["*"],
              },
            ],
          });
        }
      }
      return Effect.fn("AWS.GeoPlaces.Autocomplete")(function* (
        request: geoPlaces.AutocompleteRequest,
      ) {
        return yield* autocomplete(request);
      });
    });
  }),
);
