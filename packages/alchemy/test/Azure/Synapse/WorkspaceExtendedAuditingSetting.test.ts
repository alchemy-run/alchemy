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
    return yield* synapse.GetWorkspaceManagedSqlServerExtendedBlobAuditingPolicy(
      {
        subscriptionId,
        resourceGroupName,
        workspaceName,
        blobAuditingPolicyName: "default",
      },
    );
  });

const program = (props: { groups: string[]; predicate: string } | "unset") =>
  Effect.gen(function* () {
    const { group, workspace } = yield* lakeWorkspace();
    if (props === "unset") return { group, workspace };
    const setting = yield* Azure.Synapse.WorkspaceExtendedAuditingSetting(
      "Audit",
      {
        resourceGroup: group.resourceGroupName,
        workspace: workspace.workspaceName,
        isAzureMonitorTargetEnabled: true,
        auditActionsAndGroups: props.groups,
        predicateExpression: props.predicate,
      },
    );
    return { group, workspace, setting };
  });

// Free (no audit sink is attached); the workspace takes ~3-8 min.
test.provider(
  "enable, update, and disable synapse workspace extended auditing",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        program({
          groups: ["BATCH_COMPLETED_GROUP"],
          predicate: "statement <> 'select 1'",
        }),
      );
      const rg = created.group.resourceGroupName;
      const ws = created.workspace.workspaceName;
      expect(created.setting?.state).toEqual("Enabled");
      const observed = yield* getPolicy(rg, ws);
      expect(observed.properties?.state).toEqual("Enabled");
      expect(observed.properties?.isAzureMonitorTargetEnabled).toEqual(true);
      expect(observed.properties?.predicateExpression).toEqual(
        "statement <> 'select 1'",
      );
      expect(observed.properties?.auditActionsAndGroups).toEqual([
        "BATCH_COMPLETED_GROUP",
      ]);

      // In place: audit failed logins too, with a new predicate.
      const updated = yield* stack.deploy(
        program({
          groups: [
            "BATCH_COMPLETED_GROUP",
            "FAILED_DATABASE_AUTHENTICATION_GROUP",
          ],
          predicate: "statement <> 'select 2'",
        }),
      );
      expect(updated.setting?.settingId).toEqual(created.setting?.settingId);
      expect(
        [
          ...((yield* getPolicy(rg, ws)).properties?.auditActionsAndGroups ??
            []),
        ].sort(),
      ).toEqual([
        "BATCH_COMPLETED_GROUP",
        "FAILED_DATABASE_AUTHENTICATION_GROUP",
      ]);

      expect(
        (yield* getPolicy(rg, ws)).properties?.predicateExpression,
      ).toEqual("statement <> 'select 2'");

      // Removing it from the stack disables auditing.
      yield* stack.deploy(program("unset"));
      expect((yield* getPolicy(rg, ws)).properties?.state).toEqual("Disabled");

      yield* stack.destroy();
    }).pipe(withWorkspaceSlot, logLevel),
  {
    tags: ["provider:azure", "provider:azure:synapse", "live"],
    timeout: 900_000,
  },
);
