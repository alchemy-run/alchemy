import * as liveTables from "@distilled.cloud/starburst-galaxy/live_table";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { bindStarburstGalaxy } from "../StarburstGalaxyBindings.ts";
import { GetLiveTable } from "./GetLiveTable.ts";
import type { LiveTable } from "./LiveTable.ts";

/**
 * {@link GetLiveTable} over the Galaxy API; works on any host.
 *
 * @layer
 * @product Ingest
 * @provides StarburstGalaxy.Ingest.GetLiveTable
 */
export const GetLiveTableHttp = Layer.succeed(
  GetLiveTable,
  Effect.fn("StarburstGalaxy.Ingest.GetLiveTable")(function* (table: LiveTable) {
    const galaxy = yield* bindStarburstGalaxy;
    const liveTableIdOf = yield* table.liveTableId;
    return () =>
      galaxy.authorize(
        Effect.gen(function* () {
          const liveTableId = yield* liveTableIdOf;
          return yield* liveTables.getLiveTable({ liveTableId });
        }),
      );
  }),
);
