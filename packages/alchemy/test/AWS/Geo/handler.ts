import * as GeoPlaces from "@/AWS/GeoPlaces";
import * as GeoRoutes from "@/AWS/GeoRoutes";
import * as Lambda from "@/AWS/Lambda";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

export class GeoTestFunction extends Lambda.Function<Lambda.Function>()(
  "GeoTestFunction",
) {}

export default GeoTestFunction.make(
  {
    main,
    url: true,
    // Geo calls fan out to upstream providers and can exceed Lambda's 3s default.
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    const searchText = yield* GeoPlaces.SearchText();
    const geocode = yield* GeoPlaces.Geocode();
    const calculateRoutes = yield* GeoRoutes.CalculateRoutes();

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const pathname = new URL(request.originalUrl).pathname;

        // Cheap readiness route — no AWS call.
        if (request.method === "GET" && pathname === "/ping") {
          return yield* HttpServerResponse.json({ ok: true });
        }

        if (request.method === "GET" && pathname === "/search-text") {
          const result = yield* searchText({
            QueryText: "Space Needle, Seattle, WA",
            MaxResults: 5,
          });
          const items = result.ResultItems ?? [];
          return yield* HttpServerResponse.json({
            count: items.length,
            firstPosition: items[0]?.Position,
          });
        }

        if (request.method === "GET" && pathname === "/geocode") {
          const result = yield* geocode({
            QueryText: "1600 Pennsylvania Ave NW, Washington, DC",
            MaxResults: 1,
          });
          const items = result.ResultItems ?? [];
          return yield* HttpServerResponse.json({
            count: items.length,
            position: items[0]?.Position,
          });
        }

        if (request.method === "GET" && pathname === "/calculate-routes") {
          const result = yield* calculateRoutes({
            // [longitude, latitude] — two points in Seattle.
            Origin: [-122.339, 47.61],
            Destination: [-122.201, 47.61],
            TravelMode: "Car",
          });
          const routes = result.Routes ?? [];
          return yield* HttpServerResponse.json({
            count: routes.length,
            distance: routes[0]?.Summary?.Distance,
            duration: routes[0]?.Summary?.Duration,
          });
        }

        return yield* HttpServerResponse.json(
          { error: "Not found", method: request.method, pathname },
          { status: 404 },
        );
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        GeoPlaces.SearchTextHttp,
        GeoPlaces.GeocodeHttp,
        GeoRoutes.CalculateRoutesHttp,
      ),
    ),
  ),
);
