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

const program = (value: string[]) =>
  Effect.gen(function* () {
    const { group, workspace, pool } = yield* lakeSqlPool();
    const resource = yield* Azure.Synapse.SqlPoolAuditingSetting("Audit", {
      resourceGroup: group.resourceGroupName,
      workspace: workspace.workspaceName,
      sqlPool: pool.sqlPoolName,
      isAzureMonitorTargetEnabled: true,
      auditActionsAndGroups: value,
    });
    return { pool, resource };
  });

const observe = (pool: {
  resourceGroup: string;
  workspaceName: string;
  sqlPoolName: string;
}) =>
  Effect.gen(function* () {
    const path = yield* poolPath(pool);
    return yield* synapse.GetSqlPoolBlobAuditingPolicy({
      ...path,
      blobAuditingPolicyName: "default",
    });
  });

// Needs a DW100c dedicated SQL pool (~$1.20-1.51 per started hour, ~5-10
// min to create); the setting itself is free.
test.provider.skipIf(!runExpensive)(
  "enable and update synapse sql pool auditing",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(program(["BATCH_COMPLETED_GROUP"]));
      expect(
        (yield* observe(created.pool)).properties?.auditActionsAndGroups,
      ).toEqual(["BATCH_COMPLETED_GROUP"]);

      // In place.
      const updated = yield* stack.deploy(
        program(["FAILED_DATABASE_AUTHENTICATION_GROUP"]),
      );
      expect(updated.resource.settingId).toEqual(created.resource.settingId);
      expect(
        (yield* observe(updated.pool)).properties?.auditActionsAndGroups,
      ).toEqual(["FAILED_DATABASE_AUTHENTICATION_GROUP"]);

      yield* stack.destroy();
    }).pipe(withWorkspaceSlot, logLevel),
  {
    tags: ["provider:azure", "provider:azure:synapse", "live"],
    timeout: 900_000,
  },
);
