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
    const resource = yield* Azure.Synapse.SqlPoolSecurityAlertPolicy(
      "Threats",
      {
        resourceGroup: group.resourceGroupName,
        workspace: workspace.workspaceName,
        sqlPool: pool.sqlPoolName,
        emailAddresses: ["security@example.com"],
        disabledAlerts: value,
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
    return yield* synapse.GetSqlPoolSecurityAlertPolicy({
      ...path,
      securityAlertPolicyName: "default",
    });
  });

// Needs a DW100c dedicated SQL pool (~$1.20-1.51 per started hour, ~5-10
// min to create); the setting itself is free.
test.provider.skipIf(!runExpensive)(
  "enable and update a synapse sql pool security alert policy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(program(["Sql_Injection"]));
      expect((yield* observe(created.pool)).properties?.disabledAlerts).toEqual(
        ["Sql_Injection"],
      );

      // In place.
      const updated = yield* stack.deploy(program(["Access_Anomaly"]));
      expect(updated.resource.settingId).toEqual(created.resource.settingId);
      expect((yield* observe(updated.pool)).properties?.disabledAlerts).toEqual(
        ["Access_Anomaly"],
      );

      yield* stack.destroy();
    }).pipe(withWorkspaceSlot, logLevel),
  {
    tags: ["provider:azure", "provider:azure:synapse", "live"],
    timeout: 900_000,
  },
);
