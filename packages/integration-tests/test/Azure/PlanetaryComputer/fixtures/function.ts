import * as Azure from "@alchemy.run/azure";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import { distilledFromSource } from "../../Functions/fixtures/distilled-source.ts";

// The catalog the fixture binds. Module-scope so the test stack yields the
// same declaration.
export const Catalog = Azure.PlanetaryComputer.GeoCatalog("GcBindingsCatalog", {
  location: "eastus",
});

/** The STAC collection the write routes create and delete. */
export const COLLECTION = "alchemy-bindings";

/** Answer `{ ok, result }`, or `{ ok: false, error }` with a 500 so callers retry. */
const respond = (effect: Effect.Effect<unknown, unknown, RuntimeContext>) =>
  effect.pipe(
    Effect.flatMap((result) => HttpServerResponse.json({ ok: true, result })),
    Effect.catchCause((cause) =>
      HttpServerResponse.json({ ok: false, error: Cause.pretty(cause) }, { status: 500 }),
    ),
  );

/**
 * Effect-native Azure Function exercising the GeoCatalog STAC bindings on a
 * managed-identity host, one route per binding.
 */
export default class GcBindingsFunction extends Azure.Functions.Function<GcBindingsFunction>()(
  "GcBindingsFunction",
  {
    main: import.meta.url,
    // TEMPORARY: this checkout's distilled `lib/` is stale (see distilled-source.ts).
    build: { input: { plugins: [distilledFromSource] } },
  },
  Effect.gen(function* () {
    const catalog = yield* Catalog;
    const landingPage = yield* Azure.PlanetaryComputer.GetStacLandingPage(catalog);
    const createCollection = yield* Azure.PlanetaryComputer.CreateStacCollection(catalog);
    const getCollection = yield* Azure.PlanetaryComputer.GetStacCollection(catalog);
    const listCollections = yield* Azure.PlanetaryComputer.GetStacCollectionAll(catalog);
    const deleteCollection = yield* Azure.PlanetaryComputer.DeleteStacCollection(catalog);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://localhost");
        switch (url.pathname) {
          case "/landing":
            return yield* respond(Effect.map(landingPage(), (page) => ({ id: page.id })));
          case "/collection/create":
            return yield* respond(
              Effect.as(
                createCollection({
                  id: COLLECTION,
                  description: "Created by the Alchemy binding tests",
                  license: "proprietary",
                  links: [],
                  extent: {
                    spatial: { bbox: [[-180, -90, 180, 90]] },
                    temporal: { interval: [["2024-01-01T00:00:00Z", null]] },
                  },
                }),
                { created: COLLECTION },
              ),
            );
          case "/collection/get":
            return yield* respond(
              Effect.map(getCollection({ collectionId: COLLECTION }), (c) => ({ id: c.id })),
            );
          case "/collection/list":
            return yield* respond(
              Effect.map(listCollections(), (page) => ({
                ids: page.collections.map((c) => c.id),
              })),
            );
          case "/collection/delete":
            return yield* respond(
              Effect.as(deleteCollection({ collectionId: COLLECTION }), { deleted: COLLECTION }),
            );
          default:
            return HttpServerResponse.text("not found", { status: 404 });
        }
      }),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Azure.PlanetaryComputer.GetStacLandingPageHttp,
        Azure.PlanetaryComputer.CreateStacCollectionHttp,
        Azure.PlanetaryComputer.GetStacCollectionHttp,
        Azure.PlanetaryComputer.GetStacCollectionAllHttp,
        Azure.PlanetaryComputer.DeleteStacCollectionHttp,
      ),
    ),
  ),
) {}
