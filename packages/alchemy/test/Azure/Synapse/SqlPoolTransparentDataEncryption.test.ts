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
  withWorkspaceSlot,
} from "./fixture.ts";

const { test } = Test.make({ providers: Azure.providers() });

const program = (value: "Enabled" | "Disabled") =>
  Effect.gen(function* () {
    const { group, workspace, pool } = yield* lakeSqlPool();
    const resource = yield* Azure.Synapse.SqlPoolTransparentDataEncryption(
      "Tde",
      {
        resourceGroup: group.resourceGroupName,
        workspace: workspace.workspaceName,
        sqlPool: pool.sqlPoolName,
        status: value,
      },
    );
    return { pool, resource };
  });

const observe = (pool: {
  resourceGroup: string;
  workspaceName: string;
  sqlPoolName: string;
}) =>
  Effect.gen(function* () {
    const path = yield* poolPath(pool);
    return yield* synapse.GetSqlPoolTransparentDataEncryption({
      ...path,
      transparentDataEncryptionName: "current",
    });
  });

// Needs a DW100c dedicated SQL pool (~$1.20-1.51 per started hour, ~5-10
// min to create); the setting itself is free.
test.provider.skipIf(!runExpensive)(
  "enable and disable synapse sql pool transparent data encryption",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(program("Disabled"));
      expect((yield* observe(created.pool)).properties?.status).toEqual(
        "Disabled",
      );

      // In place.
      const updated = yield* stack.deploy(program("Enabled"));
      expect(updated.resource.settingId).toEqual(created.resource.settingId);
      expect((yield* observe(updated.pool)).properties?.status).toEqual(
        "Enabled",
      );

      yield* stack.destroy();
    }).pipe(withWorkspaceSlot, logLevel),
  {
    tags: ["provider:azure", "provider:azure:synapse", "live"],
    timeout: 900_000,
  },
);
