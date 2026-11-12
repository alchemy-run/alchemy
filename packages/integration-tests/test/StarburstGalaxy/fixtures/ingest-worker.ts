import * as Cloudflare from "@alchemy.run/cloudflare";
import * as StarburstGalaxy from "@alchemy.run/starburst-galaxy";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

/**
 * A live table loading JSON files into a lakehouse Galaxy can write: the
 * catalog ID, schema and file ingest source come from
 * STARBURST_GALAXY_TEST_LAKE_CATALOG, _SCHEMA and _SOURCE.
 */
export const LakeTable = StarburstGalaxy.Ingest.LiveTable("BindingsRaw", {
  catalogId: process.env.STARBURST_GALAXY_TEST_LAKE_CATALOG ?? "",
  schemaName: process.env.STARBURST_GALAXY_TEST_LAKE_SCHEMA ?? "",
  tableName: "alchemy_bindings_raw",
  typeProperties: {
    typeKey: "newFileIngestProperties",
    fileIngestSourceId: process.env.STARBURST_GALAXY_TEST_LAKE_SOURCE ?? "",
    fileFormat: "Json",
    pollingIntervalInMinutes: 60,
  },
});

/** A Worker that reads the live table's state through GetLiveTable. */
export default class GalaxyIngestWorker extends Cloudflare.Worker<GalaxyIngestWorker>()(
  "GalaxyIngestWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const table = yield* LakeTable;
    const getLiveTable = yield* StarburstGalaxy.Ingest.GetLiveTable(table);
    return {
      fetch: Effect.gen(function* () {
        const found = yield* getLiveTable();
        return yield* HttpServerResponse.json({
          liveTableId: found.liveTableId,
          state: found.liveTableState,
        });
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.succeed(HttpServerResponse.text(Cause.pretty(cause), { status: 500 })),
        ),
      ),
    };
  }).pipe(Effect.provide(StarburstGalaxy.Ingest.GetLiveTableHttp)),
) {}
