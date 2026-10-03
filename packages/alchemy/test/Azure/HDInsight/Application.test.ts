import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as hdinsight from "@distilled.cloud/azure/hdinsight";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { runPaidOnly } from "../gates.ts";
import {
  accountKey,
  clusterProgram,
  clusterStorage,
  logLevel,
  subscription,
  tags,
  waitGone,
} from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getApplication = (
  resourceGroupName: string,
  clusterName: string,
  applicationName: string,
) =>
  Effect.gen(function* () {
    return yield* hdinsight.GetApplication({
      subscriptionId: yield* subscription,
      resourceGroupName,
      clusterName,
      applicationName,
    });
  });

const program = (
  key: Redacted.Redacted<string>,
  appTags: Record<string, string>,
) =>
  Effect.gen(function* () {
    const { group, cluster } = yield* clusterProgram(key);
    const app = yield* Azure.HDInsight.Application("EdgeApp", {
      resourceGroup: group.resourceGroupName,
      cluster: cluster.clusterName,
      installScriptActions: [
        {
          name: "install-hue",
          // Public Hue installer from the HDInsight script-action samples.
          uri: "https://hdiconfigactions.blob.core.windows.net/linuxhueconfigactionv02/install-hue-uber-v02.sh",
        },
      ],
      tags: appTags,
    });
    return { group, cluster, app };
  });

// Needs a running cluster (12+ HDInsight cores, ~$2-4/hour, 20+ minutes)
// plus an edge node (~$0.30/hour, 10-20 minutes). The free trial's
// HDInsight cores quota is 0 (see the quota probe in Cluster.test.ts), so
// this only runs with AZURE_TEST_PAID=1 (expect ~1 hour wall clock; raise
// the timeout there).
test.provider.skipIf(!runPaidOnly)(
  "install, retag, and remove an application",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, account } = yield* stack.deploy(clusterStorage);
      const key = yield* accountKey(
        group.resourceGroupName,
        account.storageAccountName,
      );

      const { cluster, app } = yield* stack.deploy(
        program(key, { env: "test" }),
      );
      const get = () =>
        getApplication(
          group.resourceGroupName,
          cluster.clusterName,
          app.applicationName,
        );
      const observed = yield* get();
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.tags?.env).toEqual("test");

      const updated = yield* stack.deploy(program(key, { env: "prod" }));
      expect(updated.app.applicationId).toEqual(app.applicationId);
      expect((yield* get()).tags?.env).toEqual("prod");

      yield* stack.destroy();
      expect(yield* waitGone(get())).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);

// Ungated probe (resource group only, free): the HDInsight resource
// provider answers reads of applications on a missing cluster with a typed
// not-found (one of `NOT_FOUND_TAGS`) the provider's read/delete paths rely
// on.
test.provider(
  "an application on a missing cluster reads as a typed not-found",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group } = yield* stack.deploy(
        Effect.gen(function* () {
          const group = yield* Azure.Resources.ResourceGroup("Group", {
            location: "eastus",
          });
          return { group };
        }),
      );
      const error = yield* getApplication(
        group.resourceGroupName,
        "alchemy-missing-cluster",
        "missing-app",
      ).pipe(Effect.flip);
      // ARM's parent-not-found 404, typed by the SDK's 404 fallback.
      expect(error._tag).toEqual("NotFound");
      expect(error.message).toContain("could not be found");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 300_000 },
);
