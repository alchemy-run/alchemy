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

const program = (value: string) =>
  Effect.gen(function* () {
    const { group, workspace, pool } = yield* lakeSqlPool();
    const resource = yield* Azure.Synapse.SqlPoolExtendedAuditingSetting(
      "Audit",
      {
        resourceGroup: group.resourceGroupName,
        workspace: workspace.workspaceName,
        sqlPool: pool.sqlPoolName,
        isAzureMonitorTargetEnabled: true,
        predicateExpression: value,
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
    return yield* synapse.GetExtendedSqlPoolBlobAuditingPolicy({
      ...path,
      blobAuditingPolicyName: "default",
    });
  });

// Needs a DW100c dedicated SQL pool (~$1.20-1.51 per started hour, ~5-10
// min to create); the setting itself is free.
test.provider.skipIf(!runExpensive)(
  "enable and update synapse sql pool extended auditing",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(program("statement <> 'select 1'"));
      expect(
        (yield* observe(created.pool)).properties?.predicateExpression,
      ).toEqual("statement <> 'select 1'");

      // In place.
      const updated = yield* stack.deploy(program("statement <> 'select 2'"));
      expect(updated.resource.settingId).toEqual(created.resource.settingId);
      expect(
        (yield* observe(updated.pool)).properties?.predicateExpression,
      ).toEqual("statement <> 'select 2'");

      yield* stack.destroy();
    }).pipe(withWorkspaceSlot, logLevel),
  {
    tags: ["provider:azure", "provider:azure:synapse", "live"],
    timeout: 900_000,
  },
);
