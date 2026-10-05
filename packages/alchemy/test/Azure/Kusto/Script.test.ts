import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as kusto from "@distilled.cloud/azure/azure_kusto";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runExpensive } from "../gates.ts";
import { devCluster, logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getScript = (
  resourceGroupName: string,
  clusterName: string,
  databaseName: string,
  scriptName: string,
) =>
  Effect.gen(function* () {
    return yield* kusto.GetScript({
      subscriptionId: yield* subscription,
      resourceGroupName,
      clusterName,
      databaseName,
      scriptName,
    });
  });

const program = (props: { content: string; continueOnErrors?: boolean }) =>
  Effect.gen(function* () {
    const { group, cluster } = yield* devCluster();
    const database = yield* Azure.Kusto.Database("Database", {
      resourceGroup: group.resourceGroupName,
      cluster: cluster.clusterName,
    });
    const script = yield* Azure.Kusto.Script("Script", {
      resourceGroup: group.resourceGroupName,
      cluster: cluster.clusterName,
      database: database.databaseName,
      content: props.content,
      continueOnErrors: props.continueOnErrors,
    });
    return { group, cluster, database, script };
  });

// Needs a Dev Kusto cluster (~$0.25/hour, 10-20 minutes to create, 5-10
// to delete): ~$0.20 per run, ~30 minutes.
test.provider.skipIf(!runExpensive)(
  "create, re-run, and delete a Kusto script",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, cluster, database, script } = yield* stack.deploy(
        program({ content: ".create-merge table Events (Name: string)" }),
      );
      const get = () =>
        getScript(
          group.resourceGroupName,
          cluster.clusterName,
          database.databaseName,
          script.scriptName,
        );
      const observed = yield* get();
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.properties?.forceUpdateTag).toEqual(
        script.forceUpdateTag,
      );
      expect(script.forceUpdateTag).not.toEqual("");

      // In place: new content re-runs the script with a new tag.
      const updated = yield* stack.deploy(
        program({
          content:
            ".create-merge table Events (Name: string, Timestamp: datetime)",
          continueOnErrors: true,
        }),
      );
      expect(updated.script.scriptId).toEqual(script.scriptId);
      expect(updated.script.forceUpdateTag).not.toEqual(script.forceUpdateTag);
      const reobserved = yield* get();
      expect(reobserved.properties?.forceUpdateTag).toEqual(
        updated.script.forceUpdateTag,
      );
      expect(reobserved.properties?.continueOnErrors).toEqual(true);

      yield* stack.destroy();
      expect(yield* waitGone(get(), 60)).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 3_600_000 },
);
