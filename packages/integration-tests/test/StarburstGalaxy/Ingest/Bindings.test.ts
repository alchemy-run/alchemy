import * as Cloudflare from "@alchemy.run/cloudflare";
import * as StarburstGalaxy from "@alchemy.run/starburst-galaxy";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { cloudflareSkipReason } from "../fixtures/bindings.ts";
import { getJson } from "../fixtures/http.ts";
import GalaxyIngestWorker, { LakeTable } from "../fixtures/ingest-worker.ts";
import { freshStack } from "../helpers.ts";

const { test } = Test.make({
  providers: Layer.mergeAll(StarburstGalaxy.providers(), Cloudflare.providers()),
});

// A live table needs a lakehouse catalog Galaxy can write (an S3 bucket and
// credentials), an existing schema and a file ingest source: see
// Ingest/LiveTable.test.ts for STARBURST_GALAXY_TEST_LAKE_*.
const lakeSkipReason =
  process.env.STARBURST_GALAXY_TEST_LAKE_CATALOG &&
  process.env.STARBURST_GALAXY_TEST_LAKE_SCHEMA &&
  process.env.STARBURST_GALAXY_TEST_LAKE_SOURCE
    ? undefined
    : "STARBURST_GALAXY_TEST_LAKE_CATALOG, _SCHEMA and _SOURCE are not set (a live table needs a lakehouse Galaxy can write)";
const skipReason = cloudflareSkipReason ?? lakeSkipReason;

test.provider.skipIf(!!skipReason)(
  `a Worker reads a live table's state through GetLiveTable${skipReason ? ` [skipped: ${skipReason}]` : ""}`,
  (stack) =>
    Effect.gen(function* () {
      yield* freshStack(stack);
      const { url, liveTableId } = yield* stack.deploy(
        Effect.gen(function* () {
          const table = yield* LakeTable;
          const worker = yield* GalaxyIngestWorker;
          return { url: worker.url.as<string>(), liveTableId: table.liveTableId };
        }),
      );

      const found = yield* getJson<{ liveTableId: string; state: string }>(url, "/");
      expect(found.liveTableId).toBe(liveTableId);
      expect(found.state).toBe("Running");

      yield* stack.destroy();
    }).pipe(Effect.scoped),
  {
    tags: [
      "provider:starburst-galaxy",
      "provider:starburst-galaxy:ingest",
      "provider:cloudflare",
      "provider:cloudflare:worker",
      "live",
    ],
    timeout: 900_000,
  },
);
