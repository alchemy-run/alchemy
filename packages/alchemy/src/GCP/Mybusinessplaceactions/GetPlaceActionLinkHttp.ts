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
import { bindGcpHost, defaultRoleFor } from "../Host.ts";

/**
 * HTTP implementation of {@link GetPlaceActionLink}.
 *
 * @layer
 * @provides GCP.Mybusinessplaceactions.GetPlaceActionLink
 */
export const GetPlaceActionLinkHttp = Layer.effect(
  GetPlaceActionLink,
  Effect.gen(function* () {
    const getLocationsPlaceActionLinks =
      yield* placeactions.getLocationsPlaceActionLinks;
    return Effect.fn(function* (link: PlaceActionLink) {
      yield* bindGcpHost({
        tag: "GCP.Mybusinessplaceactions.GetPlaceActionLink",
        resource: link,
        iam: [
          {
            role: defaultRoleFor(
              "GCP.Mybusinessplaceactions.GetPlaceActionLink",
            ),
          },
        ],
      });
      const name = yield* link.name;
      return Effect.fn(
        `GCP.Mybusinessplaceactions.GetPlaceActionLink(${link.LogicalId})`,
      )(function* (_request: GetPlaceActionLinkRequest) {
        return yield* getLocationsPlaceActionLinks({
          name: linkNameOf(yield* name),
        });
      });
    });
  }),
);
