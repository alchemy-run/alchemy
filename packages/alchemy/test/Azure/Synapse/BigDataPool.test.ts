import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as synapse from "@distilled.cloud/azure/synapse";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  lakeWorkspace,
  logLevel,
  untilGone,
  withWorkspaceSlot,
} from "./fixture.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getPool = (
  resourceGroupName: string,
  workspaceName: string,
  bigDataPoolName: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* synapse.GetBigDataPool({
      subscriptionId,
      resourceGroupName,
      workspaceName,
      bigDataPoolName,
    });
  });

const program = (props: {
  maxNodeCount: number;
  tags: Record<string, string>;
  name?: string;
}) =>
  Effect.gen(function* () {
    const { group, workspace } = yield* lakeWorkspace();
    const pool = yield* Azure.Synapse.BigDataPool("Spark", {
      resourceGroup: group.resourceGroupName,
      workspace: workspace.workspaceName,
      name: props.name,
      nodeSize: "Small",
      autoScale: {
        enabled: true,
        minNodeCount: 3,
        maxNodeCount: props.maxNodeCount,
      },
      autoPause: { enabled: true, delayInMinutes: 15 },
      tags: props.tags,
    });
    return { group, workspace, pool };
  });

// The pool is only a definition (no compute until a session starts), so it
// costs nothing; the workspace takes ~3-8 min, the pool ~1-3 min.
test.provider(
  "create, update, replace, and delete a synapse spark pool",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, workspace, pool } = yield* stack.deploy(
        program({ maxNodeCount: 3, tags: { env: "test" } }),
      );
      const rg = group.resourceGroupName;
      const ws = workspace.workspaceName;
      expect(pool.bigDataPoolName).toMatch(/^[a-zA-Z][a-zA-Z0-9]{0,14}$/);
      expect(pool.nodeSize).toEqual("Small");
      const observed = yield* getPool(rg, ws, pool.bigDataPoolName);
      expect(observed.properties?.autoScale?.maxNodeCount).toEqual(3);
      expect(observed.properties?.autoPause?.delayInMinutes).toEqual(15);
      expect(observed.tags?.env).toEqual("test");

      // In place: autoscale max + tags.
      const updated = yield* stack.deploy(
        program({ maxNodeCount: 5, tags: { env: "prod" } }),
      );
      expect(updated.pool.bigDataPoolId).toEqual(pool.bigDataPoolId);
      const reobserved = yield* getPool(rg, ws, pool.bigDataPoolName);
      expect(reobserved.properties?.autoScale?.maxNodeCount).toEqual(5);
      expect(reobserved.tags?.env).toEqual("prod");

      // Replace: rename.
      const renamed = yield* stack.deploy(
        program({
          maxNodeCount: 5,
          tags: { env: "prod" },
          name: "sparkrenamed",
        }),
      );
      expect(renamed.pool.bigDataPoolName).toEqual("sparkrenamed");
      expect(yield* untilGone(getPool(rg, ws, pool.bigDataPoolName))).toEqual(
        "gone",
      );

      yield* stack.destroy();
      expect(yield* untilGone(getPool(rg, ws, "sparkrenamed"))).toEqual("gone");
    }).pipe(withWorkspaceSlot, logLevel),
  {
    tags: ["provider:azure", "provider:azure:synapse", "live"],
    timeout: 900_000,
  },
);
