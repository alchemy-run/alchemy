import * as Azure from "@alchemy.run/azure";
import type { ArmResourceId } from "@alchemy.run/azure/internal/ArmActionBinding";
import * as synapse from "@distilled.cloud/azure/synapse";
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
import { untilGone } from "./fixture.ts";
import SynapseFunction, { Pool, Workspace } from "./fixtures/function.ts";

const tags = ["provider:azure", "provider:azure:synapse", "live"];

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Azure.providers(),
  state: Alchemy.localState(),
});

const Stack = Alchemy.Stack(
  "AzureSynapseBindings",
  { providers: Azure.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const fn = yield* SynapseFunction;
    const workspace = yield* Workspace;
    const pool = yield* Pool;
    return {
      url: fn.url,
      principalId: fn.principalId,
      hostStorageAccount: fn.storageAccountName,
      resourceGroup: workspace.resourceGroup,
      workspaceName: workspace.workspaceName,
      sqlPoolName: pool.sqlPoolName,
      sqlPoolId: pool.sqlPoolId,
    };
  }),
);

// A DW100c dedicated SQL pool (~$1.20/hour, 5-10 min to provision) in a
// new workspace, paused and resumed, plus a Flex Consumption app: ~$1/run,
// so the suite runs only with AZURE_TEST_EXPENSIVE=1 (as the SqlPool suite
// does).
const stack = runExpensive ? beforeAll(deploy(Stack), { timeout: 2_700_000 }) : undefined;

const url = Effect.suspend(() => Effect.map(stack!, (outputs) => outputs.url));

const poolRef = Effect.gen(function* () {
  const { subscriptionId } = yield* Azure.AzureEnvironment.current;
  const { resourceGroup, workspaceName, sqlPoolName } = yield* stack!;
  return { subscriptionId, resourceGroupName: resourceGroup, workspaceName, sqlPoolName };
});

/** The pool's `status`, polled until it is `status`. */
const untilStatus = (status: string) =>
  Effect.gen(function* () {
    const ref = yield* poolRef;
    return yield* synapse.GetSqlPool(ref).pipe(
      Effect.map((pool) => pool.properties?.status),
      Effect.repeat({
        schedule: Schedule.spaced("15 seconds"),
        until: (observed) => observed === status,
        times: 40,
      }),
    );
  }).pipe(Effect.provide(azure));

const poolOf = (id: ArmResourceId) => ({
  subscriptionId: id.subscriptionId,
  resourceGroupName: id.resourceGroupName,
  workspaceName: id.name("workspaces"),
  sqlPoolName: id.name("sqlPools"),
});

const runtimeOf = (id: ArmResourceId) => ({
  subscriptionId: id.subscriptionId,
  resourceGroupName: id.resourceGroupName,
  workspaceName: id.name("workspaces"),
  integrationRuntimeName: id.name("integrationRuntimes"),
});

// Ungated: each binding's request, with the identifiers it derives from the
// bound resource's ARM ID, reaches ARM's route for the action. The
// integration-runtime bindings act only on managed (Azure-SSIS) runtimes,
// which Azure.Synapse.IntegrationRuntime does not create; they are covered
// here only.
describe("Synapse runtime-action requests", { tags }, () => {
  for (const [binding, path, send] of [
    [
      "PauseSqlPool",
      "Microsoft.Synapse/workspaces/wsprobe/sqlPools/dwprobe",
      (id: ArmResourceId) => synapse.PauseSqlPool(poolOf(id)),
    ],
    [
      "ResumeSqlPool",
      "Microsoft.Synapse/workspaces/wsprobe/sqlPools/dwprobe",
      (id: ArmResourceId) => synapse.ResumeSqlPool(poolOf(id)),
    ],
    [
      "StartIntegrationRuntime",
      "Microsoft.Synapse/workspaces/wsprobe/integrationRuntimes/irprobe",
      (id: ArmResourceId) => synapse.StartIntegrationRuntime(runtimeOf(id)),
    ],
    [
      "StopIntegrationRuntime",
      "Microsoft.Synapse/workspaces/wsprobe/integrationRuntimes/irprobe",
      (id: ArmResourceId) => synapse.StopIntegrationRuntime(runtimeOf(id)),
    ],
  ] as const) {
    test(
      `Synapse.${binding} addresses the bound resource`,
      Effect.gen(function* () {
        const tag = yield* probe(path, send);
        expect(tag).toEqual("ResourceGroupNotFound");
      }),
    );
  }
});

// Pause and resume act on one pool: run them in order.
describe.skipIf(!runExpensive).sequential("Synapse bindings on an Azure Function", { tags }, () => {
  describe("Synapse.PauseSqlPool", () => {
    test(
      "pauses the bound SQL pool",
      Effect.gen(function* () {
        const body = yield* call(url, "/pause");
        expectOk(body);
        expect(yield* untilStatus("Paused")).toEqual("Paused");
      }),
      { timeout: 900_000 },
    );
  });

  describe("Synapse.ResumeSqlPool", () => {
    test(
      "resumes the bound SQL pool",
      Effect.gen(function* () {
        const body = yield* call(url, "/resume");
        expectOk(body);
        expect(yield* untilStatus("Online")).toEqual("Online");
      }),
      { timeout: 900_000 },
    );
  });

  describe("AzureBindings.Bind least privilege", () => {
    test(
      "assigns exactly each binding's action on the SQL pool only",
      Effect.gen(function* () {
        const outputs = yield* stack!;
        const grants = yield* awaitGrants(outputs.principalId!, outputs.hostStorageAccount, 2);
        const pool = outputs.sqlPoolId.toLowerCase();
        expect(grants).toEqual(
          ["pause", "resume"].map(
            (verb) => `Microsoft.Synapse/workspaces/sqlPools/${verb}/action ${pool}`,
          ),
        );
      }),
      { timeout: 300_000 },
    );
  });
});

if (runExpensive) {
  // Destroy, then prove the pool and every role on the Function's identity are gone.
  afterAll.skipIf(!!process.env.NO_DESTROY)(
    Effect.gen(function* () {
      const { principalId, hostStorageAccount } = yield* stack!;
      const ref = yield* poolRef;
      yield* destroy(Stack);
      expect(yield* awaitNoGrants(principalId!, hostStorageAccount)).toEqual([]);
      expect(yield* untilGone(synapse.GetSqlPool(ref))).toEqual("gone");
    }).pipe(Effect.provide(azure)),
    { timeout: 1_800_000 },
  );
}
