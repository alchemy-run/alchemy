import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as synapse from "@distilled.cloud/azure/synapse";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { lakeWorkspace, logLevel, withWorkspaceSlot } from "./fixture.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getPolicy = (resourceGroupName: string, workspaceName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* synapse.GetWorkspaceManagedSqlServerSecurityAlertPolicy({
      subscriptionId,
      resourceGroupName,
      workspaceName,
      securityAlertPolicyName: "Default",
    });
  });

const program = (props: { disabledAlerts: string[] } | "unset") =>
  Effect.gen(function* () {
    const { group, workspace } = yield* lakeWorkspace();
    if (props === "unset") return { group, workspace };
    const policy = yield* Azure.Synapse.WorkspaceSecurityAlertPolicy(
      "Threats",
      {
        resourceGroup: group.resourceGroupName,
        workspace: workspace.workspaceName,
        emailAddresses: ["security@example.com"],
        disabledAlerts: props.disabledAlerts,
      },
    );
    return { group, workspace, policy };
  });

// Microsoft Defender for SQL is prorated hourly (~$15/month per workspace),
// so the few minutes it is on cost well under $0.05; the workspace takes
// ~3-8 min.
test.provider(
  "enable, update, and disable a synapse workspace security alert policy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        program({ disabledAlerts: ["Sql_Injection"] }),
      );
      const rg = created.group.resourceGroupName;
      const ws = created.workspace.workspaceName;
      expect(created.policy?.state).toEqual("Enabled");
      const observed = yield* getPolicy(rg, ws);
      expect(observed.properties?.state).toEqual("Enabled");
      expect(observed.properties?.emailAddresses).toEqual([
        "security@example.com",
      ]);
      expect(observed.properties?.disabledAlerts).toEqual(["Sql_Injection"]);

      // In place: suppress a different alert.
      const updated = yield* stack.deploy(
        program({ disabledAlerts: ["Access_Anomaly"] }),
      );
      expect(updated.policy?.policyId).toEqual(created.policy?.policyId);
      expect((yield* getPolicy(rg, ws)).properties?.disabledAlerts).toEqual([
        "Access_Anomaly",
      ]);

      // Removing it from the stack disables threat detection.
      yield* stack.deploy(program("unset"));
      expect((yield* getPolicy(rg, ws)).properties?.state).toEqual("Disabled");

      yield* stack.destroy();
    }).pipe(withWorkspaceSlot, logLevel),
  {
    tags: ["provider:azure", "provider:azure:synapse", "live"],
    timeout: 900_000,
  },
);
