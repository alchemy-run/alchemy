import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as synapse from "@distilled.cloud/azure/synapse";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runExpensive } from "../gates.ts";
import {
  lakeSqlPool,
  logLevel,
  poolPath,
  untilGone,
  withWorkspaceSlot,
} from "./fixture.ts";

const { test } = Test.make({ providers: Azure.providers() });

// A DW100c pool costs ~$1.20-1.51 per started hour (scaling to DW200c
// doubles that for the rest of the hour) and takes ~5-10 min to create.
test.provider.skipIf(!runExpensive)(
  "create, scale, and delete a synapse dedicated sql pool",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { pool } = yield* stack.deploy(
        lakeSqlPool({ tags: { env: "test" } }),
      );
      expect(pool.sku).toEqual("DW100c");
      expect(pool.status).toEqual("Online");
      const path = yield* poolPath(pool);
      const observed = yield* synapse.GetSqlPool(path);
      expect(observed.tags?.env).toEqual("test");

      // In place: scale and retag.
      const scaled = yield* stack.deploy(
        lakeSqlPool({ sku: "DW200c", tags: { env: "prod" } }),
      );
      expect(scaled.pool.sqlPoolId).toEqual(pool.sqlPoolId);
      const rescaled = yield* synapse.GetSqlPool(path);
      expect(rescaled.sku?.name).toEqual("DW200c");
      expect(rescaled.tags?.env).toEqual("prod");

      yield* stack.destroy();
      expect(yield* untilGone(synapse.GetSqlPool(path))).toEqual("gone");
    }).pipe(withWorkspaceSlot, logLevel),
  {
    tags: ["provider:azure", "provider:azure:synapse", "live"],
    timeout: 900_000,
  },
);
