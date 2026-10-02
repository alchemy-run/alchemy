import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as synapse from "@distilled.cloud/azure/synapse";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { lakeWorkspace, logLevel, withWorkspaceSlot } from "./fixture.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getSetting = (resourceGroupName: string, workspaceName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* synapse.GetAzureADOnlyAuthentication({
      subscriptionId,
      resourceGroupName,
      workspaceName,
      azureADOnlyAuthenticationName: "default",
    });
  });

const program = (props: { entraOnly: boolean | "unset" }) =>
  Effect.gen(function* () {
    const { group, workspace } = yield* lakeWorkspace();
    const identity = yield* Azure.ManagedIdentity.UserAssignedIdentity("Dba", {
      resourceGroup: group.resourceGroupName,
    });
    const admin = yield* Azure.Synapse.WorkspaceAadAdmin("Admin", {
      resourceGroup: group.resourceGroupName,
      workspace: workspace.workspaceName,
      login: identity.identityName,
      sid: identity.principalId,
    });
    if (props.entraOnly === "unset") return { group, workspace };
    const setting = yield* Azure.Synapse.AzureADOnlyAuthentication(
      "EntraOnly",
      {
        resourceGroup: group.resourceGroupName,
        workspace: admin.workspaceName,
        azureADOnlyAuthentication: props.entraOnly,
      },
    );
    return { group, workspace, setting };
  });

// Free; the workspace takes ~3-8 min.
test.provider(
  "enable, disable, and reset synapse entra-only authentication",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(program({ entraOnly: true }));
      const rg = created.group.resourceGroupName;
      const ws = created.workspace.workspaceName;
      expect(created.setting?.azureADOnlyAuthentication).toEqual(true);
      expect(
        (yield* getSetting(rg, ws)).properties?.azureADOnlyAuthentication,
      ).toEqual(true);

      // In place: turn it off.
      const updated = yield* stack.deploy(program({ entraOnly: false }));
      expect(updated.setting?.settingId).toEqual(created.setting?.settingId);
      expect(
        (yield* getSetting(rg, ws)).properties?.azureADOnlyAuthentication,
      ).toEqual(false);

      // Turn it on again, then remove it from the stack: delete resets it.
      yield* stack.deploy(program({ entraOnly: true }));
      yield* stack.deploy(program({ entraOnly: "unset" }));
      expect(
        (yield* getSetting(rg, ws)).properties?.azureADOnlyAuthentication,
      ).toEqual(false);

      yield* stack.destroy();
    }).pipe(withWorkspaceSlot, logLevel),
  {
    tags: ["provider:azure", "provider:azure:synapse", "live"],
    timeout: 900_000,
  },
);
