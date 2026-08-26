import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as placeactions from "@distilled.cloud/gcp/mybusinessplaceactions_v1";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/unstable/http/HttpClient";
import {
  GetPlaceActionLink,
  type GetPlaceActionLinkRequest,
} from "./GetPlaceActionLink.ts";
import { linkNameOf } from "./internal.ts";
import type { PlaceActionLink } from "./PlaceActionLink.ts";

/**
 * HTTP implementation of {@link GetPlaceActionLink}.
 *
 * @layer
 * @provides GCP.Mybusinessplaceactions.GetPlaceActionLink
 */
export const GetPlaceActionLinkHttp = Layer.effect(
  GetPlaceActionLink,
  Effect.gen(function* () {
    const credentials = yield* Credentials;
    const httpClient = yield* HttpClient.HttpClient;
    return Effect.fn(function* (link: PlaceActionLink) {
      const name = yield* link.name;
      return Effect.fn(
        `GCP.Mybusinessplaceactions.GetPlaceActionLink(${link.LogicalId})`,
      )(function* (_request: GetPlaceActionLinkRequest) {
        return yield* placeactions
          .getLocationsPlaceActionLinks({
            name: linkNameOf(yield* name),
          })
          .pipe(
            Effect.provideService(Credentials, credentials),
            Effect.provideService(HttpClient.HttpClient, httpClient),
          );
      });
    });
  }),
);
