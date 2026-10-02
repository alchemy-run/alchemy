import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as synapse from "@distilled.cloud/azure/synapse";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { lakeWorkspace, logLevel, withWorkspaceSlot } from "./fixture.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getProtector = (resourceGroupName: string, workspaceName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* synapse.GetWorkspaceManagedSqlServerEncryptionProtector({
      subscriptionId,
      resourceGroupName,
      workspaceName,
      encryptionProtectorName: "current",
    });
  });

const program = Effect.gen(function* () {
  const { group, workspace } = yield* lakeWorkspace();
  const protector = yield* Azure.Synapse.EncryptionProtector("Protector", {
    resourceGroup: group.resourceGroupName,
    workspace: workspace.workspaceName,
    serverKeyType: "ServiceManaged",
  });
  return { group, workspace, protector };
});

// Free; the workspace takes ~3-8 min. Switching to `AzureKeyVault` needs a
// customer-managed-key workspace (see WorkspaceKey.test.ts, gated), so this
// covers the service-managed protector only.
test.provider(
  "converge a synapse workspace encryption protector",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, workspace, protector } = yield* stack.deploy(program);
      expect(protector.serverKeyType).toEqual("ServiceManaged");
      const observed = yield* getProtector(
        group.resourceGroupName,
        workspace.workspaceName,
      );
      expect(observed.properties?.serverKeyType).toEqual("ServiceManaged");

      // Re-deploying is a no-op that keeps the same protector.
      const again = yield* stack.deploy(program);
      expect(again.protector.protectorId).toEqual(protector.protectorId);

      yield* stack.destroy();
    }).pipe(withWorkspaceSlot, logLevel),
  {
    tags: ["provider:azure", "provider:azure:synapse", "live"],
    timeout: 900_000,
  },
);
