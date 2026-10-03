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

const program = (value: number) =>
  Effect.gen(function* () {
    const { group, workspace, pool } = yield* lakeSqlPool();
    const resource = yield* Azure.Synapse.WorkloadGroup("Loads", {
      resourceGroup: group.resourceGroupName,
      workspace: workspace.workspaceName,
      sqlPool: pool.sqlPoolName,
      minResourcePercent: 0,
      maxResourcePercent: value,
      minResourcePercentPerRequest: 3,
    });
    return { pool, resource };
  });

const observe = (
  pool: { resourceGroup: string; workspaceName: string; sqlPoolName: string },
  workloadGroupName: string,
) =>
  Effect.gen(function* () {
    const path = yield* poolPath(pool);
    return yield* synapse.GetSqlPoolWorkloadGroup({
      ...path,
      workloadGroupName,
    });
  });

// Needs a DW100c dedicated SQL pool (~$1.20-1.51 per started hour, ~5-10
// min to create); the setting itself is free.
test.provider.skipIf(!runExpensive)(
  "create, update, and delete a synapse workload group",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(program(100));
      expect(
        (yield* observe(created.pool, created.resource.workloadGroupName))
          .properties?.maxResourcePercent,
      ).toEqual(100);

      // In place.
      const updated = yield* stack.deploy(program(50));
      expect(updated.resource.workloadGroupId).toEqual(
        created.resource.workloadGroupId,
      );
      expect(
        (yield* observe(updated.pool, updated.resource.workloadGroupName))
          .properties?.maxResourcePercent,
      ).toEqual(50);

      yield* stack.destroy();
      expect(
        yield* untilGone(
          observe(created.pool, created.resource.workloadGroupName),
        ),
      ).toEqual("gone");
    }).pipe(withWorkspaceSlot, logLevel),
  {
    tags: ["provider:azure", "provider:azure:synapse", "live"],
    timeout: 900_000,
  },
);
