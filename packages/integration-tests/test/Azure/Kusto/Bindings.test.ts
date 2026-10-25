import * as Azure from "@alchemy.run/azure";
import type { ArmResourceId } from "@alchemy.run/azure/internal/ArmActionBinding";
import * as kusto from "@distilled.cloud/azure/azure_kusto";
import * as Alchemy from "alchemy";
import { describe, expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import {
  awaitGrants,
  awaitNoGrants,
  azure,
  call,
  expectOk,
  probe,
} from "../arm-action-bindings.ts";
import { runExpensive } from "../gates.ts";
import KustoFunction, { Cluster } from "./fixtures/function.ts";
import { subscription, tags, waitGone } from "./util.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Azure.providers(),
  state: Alchemy.localState(),
});

const Stack = Alchemy.Stack(
  "AzureKustoBindings",
  { providers: Azure.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const fn = yield* KustoFunction;
    const cluster = yield* Cluster;
    return {
      url: fn.url,
      principalId: fn.principalId,
      hostStorageAccount: fn.storageAccountName,
      resourceGroup: cluster.resourceGroup,
      clusterName: cluster.clusterName,
      clusterId: cluster.clusterId,
    };
  }),
);

// Dev(No SLA)_Standard_E2a_v4 cluster (~$0.25/hour) created (10-20 min),
// stopped and started (5-10 min each) plus a Flex Consumption app:
// ~$0.25/run but ~45 min, so the suite runs only with
// AZURE_TEST_EXPENSIVE=1 (as the Cluster suite does).
const stack = runExpensive ? beforeAll(deploy(Stack), { timeout: 2_700_000 }) : undefined;

const url = Effect.suspend(() => Effect.map(stack!, (outputs) => outputs.url));

/** The cluster's `state`, polled until it is `state`. */
const untilState = (state: string) =>
  Effect.gen(function* () {
    const { resourceGroup, clusterName } = yield* stack!;
    const subscriptionId = yield* subscription;
    return yield* kusto
      .GetCluster({ subscriptionId, resourceGroupName: resourceGroup, clusterName })
      .pipe(
        Effect.map((cluster) => cluster.properties?.state),
        Effect.repeat({
          schedule: Schedule.spaced("20 seconds"),
          until: (observed) => observed === state,
          times: 45,
        }),
      );
  }).pipe(Effect.provide(azure));

const clusterOf = (id: ArmResourceId) => ({
  subscriptionId: id.subscriptionId,
  resourceGroupName: id.resourceGroupName,
  clusterName: id.name("clusters"),
});

// Ungated: each binding's request, with the identifiers it derives from the
// bound cluster's ARM ID, reaches ARM's route for the action.
describe("Kusto runtime-action requests", { tags }, () => {
  for (const [binding, send] of [
    ["StopCluster", (id: ArmResourceId) => kusto.StopCluster(clusterOf(id))],
    ["StartCluster", (id: ArmResourceId) => kusto.StartCluster(clusterOf(id))],
  ] as const) {
    test(
      `Kusto.${binding} addresses the bound cluster`,
      Effect.gen(function* () {
        const tag = yield* probe("Microsoft.Kusto/clusters/kustoprobe", send);
        expect(tag).toEqual("ResourceGroupNotFound");
      }),
    );
  }
});

// Stop and start act on one cluster: run them in order.
describe.skipIf(!runExpensive).sequential("Kusto bindings on an Azure Function", { tags }, () => {
  describe("Kusto.StopCluster", () => {
    test(
      "stops the bound cluster",
      Effect.gen(function* () {
        const body = yield* call(url, "/stop");
        expectOk(body);
        expect(yield* untilState("Stopped")).toEqual("Stopped");
      }),
      { timeout: 1_200_000 },
    );
  });

  describe("Kusto.StartCluster", () => {
    test(
      "starts the bound cluster",
      Effect.gen(function* () {
        const body = yield* call(url, "/start");
        expectOk(body);
        expect(yield* untilState("Running")).toEqual("Running");
      }),
      { timeout: 1_200_000 },
    );
  });

  describe("AzureBindings.Bind least privilege", () => {
    test(
      "assigns exactly each binding's action on the cluster only",
      Effect.gen(function* () {
        const outputs = yield* stack!;
        const grants = yield* awaitGrants(outputs.principalId!, outputs.hostStorageAccount, 2);
        const cluster = outputs.clusterId.toLowerCase();
        expect(grants).toEqual(
          ["Start", "Stop"].map((verb) => `Microsoft.Kusto/Clusters/${verb}/action ${cluster}`),
        );
      }),
      { timeout: 300_000 },
    );
  });
});

if (runExpensive) {
  // Destroy, then prove the cluster and every role on the Function's identity are gone.
  afterAll.skipIf(!!process.env.NO_DESTROY)(
    Effect.gen(function* () {
      const { principalId, hostStorageAccount, resourceGroup, clusterName } = yield* stack!;
      yield* destroy(Stack);
      expect(yield* awaitNoGrants(principalId!, hostStorageAccount)).toEqual([]);
      const subscriptionId = yield* subscription;
      expect(
        yield* waitGone(
          kusto.GetCluster({ subscriptionId, resourceGroupName: resourceGroup, clusterName }),
          60,
        ),
      ).toEqual("gone");
    }).pipe(Effect.provide(azure)),
    { timeout: 1_800_000 },
  );
}
