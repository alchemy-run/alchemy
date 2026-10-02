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

const program = (importance: "normal" | "high") =>
  Effect.gen(function* () {
    const { group, workspace, pool } = yield* lakeSqlPool();
    const loads = yield* Azure.Synapse.WorkloadGroup("Loads", {
      resourceGroup: group.resourceGroupName,
      workspace: workspace.workspaceName,
      sqlPool: pool.sqlPoolName,
      minResourcePercent: 0,
      maxResourcePercent: 100,
      minResourcePercentPerRequest: 3,
    });
    const classifier = yield* Azure.Synapse.WorkloadClassifier("Loader", {
      resourceGroup: group.resourceGroupName,
      workspace: workspace.workspaceName,
      sqlPool: pool.sqlPoolName,
      workloadGroup: loads.workloadGroupName,
      memberName: "dbo",
      label: "nightly-load",
      importance,
    });
    return { pool, loads, classifier };
  });

const getClassifier = (
  pool: { resourceGroup: string; workspaceName: string; sqlPoolName: string },
  workloadGroupName: string,
  workloadClassifierName: string,
) =>
  Effect.gen(function* () {
    const path = yield* poolPath(pool);
    return yield* synapse.GetSqlPoolWorkloadClassifier({
      ...path,
      workloadGroupName,
      workloadClassifierName,
    });
  });

// Needs an online DW100c dedicated SQL pool (~$1.20-1.51 per started hour,
// ~5-10 min to create); the classifier itself is free.
test.provider.skipIf(!runExpensive)(
  "create, update, and delete a synapse workload classifier",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { pool, loads, classifier } = yield* stack.deploy(
        program("normal"),
      );
      const get = getClassifier(
        pool,
        loads.workloadGroupName,
        classifier.workloadClassifierName,
      );
      expect((yield* get).properties?.memberName).toEqual("dbo");
      expect((yield* get).properties?.importance).toEqual("normal");

      // In place: raise importance.
      const updated = yield* stack.deploy(program("high"));
      expect(updated.classifier.workloadClassifierId).toEqual(
        classifier.workloadClassifierId,
      );
      expect((yield* get).properties?.importance).toEqual("high");

      yield* stack.destroy();
      expect(yield* untilGone(get)).toEqual("gone");
    }).pipe(withWorkspaceSlot, logLevel),
  {
    tags: ["provider:azure", "provider:azure:synapse", "live"],
    timeout: 900_000,
  },
);
