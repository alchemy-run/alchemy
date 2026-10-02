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
    return yield* synapse.GetWorkspaceManagedSqlServerDedicatedSQLMinimalTlsSettings(
      {
        subscriptionId,
        resourceGroupName,
        workspaceName,
        dedicatedSQLminimalTlsSettingsName: "default",
      },
    );
  });

const program = (props: { version: "1.1" | "1.2" | "unset" }) =>
  Effect.gen(function* () {
    const { group, workspace } = yield* lakeWorkspace();
    if (props.version === "unset") return { group, workspace };
    const setting = yield* Azure.Synapse.DedicatedSqlMinimalTlsSetting("Tls", {
      resourceGroup: group.resourceGroupName,
      workspace: workspace.workspaceName,
      minimalTlsVersion: props.version,
    });
    return { group, workspace, setting };
  });

// Free; the workspace takes ~3-8 min.
test.provider(
  "set, change, and reset the synapse dedicated sql minimal tls version",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(program({ version: "1.1" }));
      const rg = created.group.resourceGroupName;
      const ws = created.workspace.workspaceName;
      expect(created.setting?.minimalTlsVersion).toEqual("1.1");
      expect((yield* getSetting(rg, ws)).properties?.minimalTlsVersion).toEqual(
        "1.1",
      );

      // In place: require TLS 1.2.
      const updated = yield* stack.deploy(program({ version: "1.2" }));
      expect(updated.setting?.settingId).toEqual(created.setting?.settingId);
      expect((yield* getSetting(rg, ws)).properties?.minimalTlsVersion).toEqual(
        "1.2",
      );

      // Back to 1.1, then remove it from the stack: delete restores 1.2.
      yield* stack.deploy(program({ version: "1.1" }));
      yield* stack.deploy(program({ version: "unset" }));
      expect((yield* getSetting(rg, ws)).properties?.minimalTlsVersion).toEqual(
        "1.2",
      );

      yield* stack.destroy();
    }).pipe(withWorkspaceSlot, logLevel),
  {
    tags: ["provider:azure", "provider:azure:synapse", "live"],
    timeout: 900_000,
  },
);
