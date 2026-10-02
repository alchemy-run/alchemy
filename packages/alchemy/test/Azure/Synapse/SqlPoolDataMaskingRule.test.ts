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

/**
 * A masking rule must reference an existing column, which only T-SQL DDL
 * can create (no ARM API). Point this at a `schema.table.column` that a
 * pre-provisioning step created in the pool.
 */
const column = process.env.AZURE_TEST_SYNAPSE_MASKED_COLUMN?.split(".");

const program = (maskingFunction: "Default" | "Email") =>
  Effect.gen(function* () {
    const { group, workspace, pool } = yield* lakeSqlPool();
    const policy = yield* Azure.Synapse.SqlPoolDataMaskingPolicy("Masking", {
      resourceGroup: group.resourceGroupName,
      workspace: workspace.workspaceName,
      sqlPool: pool.sqlPoolName,
    });
    const rule = yield* Azure.Synapse.SqlPoolDataMaskingRule("Email", {
      resourceGroup: group.resourceGroupName,
      workspace: workspace.workspaceName,
      sqlPool: policy.sqlPoolName,
      schemaName: column?.[0] ?? "dbo",
      tableName: column?.[1] ?? "customers",
      columnName: column?.[2] ?? "email",
      maskingFunction,
    });
    return { pool, rule };
  });

// Needs a DW100c dedicated SQL pool (~$1.20-1.51 per started hour, ~5-10
// min to create) and a table created with T-SQL.
test.provider.skipIf(!runExpensive || column === undefined)(
  "create, update, and disable a synapse sql pool data masking rule",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { pool, rule } = yield* stack.deploy(program("Default"));
      const path = yield* poolPath(pool);
      const get = synapse.GetDataMaskingRule({
        ...path,
        dataMaskingPolicyName: "Default",
        dataMaskingRuleName: rule.ruleName,
      });
      expect((yield* get).properties?.maskingFunction).toEqual("Default");

      yield* stack.deploy(program("Email"));
      expect((yield* get).properties?.maskingFunction).toEqual("Email");

      yield* stack.destroy();
    }).pipe(withWorkspaceSlot, logLevel),
  {
    tags: ["provider:azure", "provider:azure:synapse", "live"],
    timeout: 900_000,
  },
);
