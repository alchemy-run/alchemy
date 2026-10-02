import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as synapse from "@distilled.cloud/azure/synapse";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { lakeWorkspace, logLevel, withWorkspaceSlot } from "./fixture.ts";

const { test } = Test.make({ providers: Azure.providers() });

const desiredState = (resourceGroupName: string, workspaceName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    const setting =
      yield* synapse.GetWorkspaceManagedIdentitySqlControlSettings({
        subscriptionId,
        resourceGroupName,
        workspaceName,
      });
    return setting.properties?.grantSqlControlToManagedIdentity?.desiredState;
  });

const program = (props: { grant: boolean | "unset" }) =>
  Effect.gen(function* () {
    const { group, workspace } = yield* lakeWorkspace();
    if (props.grant === "unset") return { group, workspace };
    const setting = yield* Azure.Synapse.ManagedIdentitySqlControlSetting(
      "MsiSql",
      {
        resourceGroup: group.resourceGroupName,
        workspace: workspace.workspaceName,
        grantSqlControlToManagedIdentity: props.grant,
      },
    );
    return { group, workspace, setting };
  });

// Free; the workspace takes ~3-8 min.
test.provider(
  "grant, revoke, and reset synapse managed identity sql control",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(program({ grant: true }));
      const rg = created.group.resourceGroupName;
      const ws = created.workspace.workspaceName;
      expect(created.setting?.desiredState).toEqual("Enabled");
      expect(yield* desiredState(rg, ws)).toEqual("Enabled");

      // In place: revoke.
      const updated = yield* stack.deploy(program({ grant: false }));
      expect(updated.setting?.settingId).toEqual(created.setting?.settingId);
      expect(yield* desiredState(rg, ws)).toEqual("Disabled");

      // Grant again, then remove it from the stack: delete revokes.
      yield* stack.deploy(program({ grant: true }));
      yield* stack.deploy(program({ grant: "unset" }));
      expect(yield* desiredState(rg, ws)).toEqual("Disabled");

      yield* stack.destroy();
    }).pipe(withWorkspaceSlot, logLevel),
  {
    tags: ["provider:azure", "provider:azure:synapse", "live"],
    timeout: 900_000,
  },
);
