import * as Azure from "@alchemy.run/azure";
import * as syms from "@distilled.cloud/azure/synapse-data";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { lakeWorkspace, logLevel, withWorkspaceSlot } from "./fixture.ts";

const { test } = Test.make({ providers: Azure.providers() });

const endpointOf = (workspace: string) => `https://${workspace}.dev.azuresynapse.net`;

/** An assignment as the workspace reports it: `<role> <principal> <scope>`, or `"gone"`. */
const observed = (workspace: string, roleAssignmentId: string) =>
  syms.GetRoleAssignmentById({ endpoint: endpointOf(workspace), roleAssignmentId }).pipe(
    Effect.map((a) => `${a.roleDefinitionId} ${a.principalId} ${a.scope}`),
    Effect.catchTag("RoleAssignmentNotFound", () => Effect.succeed("gone")),
  );

const untilGone = (workspace: string, roleAssignmentId: string) =>
  observed(workspace, roleAssignmentId).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (s) => s === "gone",
      times: 12,
    }),
  );

/**
 * Workspace + allow-all firewall (the test runner calls the development
 * endpoint) + an Entra service principal that gets the role.
 */
const program = (props: { roleId?: string }) =>
  Effect.gen(function* () {
    const parent = yield* lakeWorkspace();
    yield* Azure.Synapse.FirewallRule("AllowAll", {
      resourceGroup: parent.group.resourceGroupName,
      workspace: parent.workspace.workspaceName,
      name: "allowAll",
      startIpAddress: "0.0.0.0",
      endIpAddress: "255.255.255.255",
    });
    const app = yield* Azure.Entra.Application("Reader", {
      displayName: "alchemy synapse role assignment test",
    });
    const principal = yield* Azure.Entra.ServicePrincipal("ReaderPrincipal", {
      appId: app.appId,
    });
    const assignment =
      props.roleId === undefined
        ? undefined
        : yield* Azure.Synapse.WorkspaceRoleAssignment("ReaderRole", {
            workspace: parent.workspace.workspaceName,
            roleId: props.roleId,
            principalId: principal.objectId,
            principalType: "ServicePrincipal",
          });
    return { ...parent, principal, assignment };
  });

// A workspace is free while idle; provisioning takes ~3-8 min.
test.provider(
  "create, replace, and delete a Synapse workspace role assignment",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        program({ roleId: Azure.Synapse.SynapseRole.ArtifactUser }),
      );
      const workspace = created.workspace.workspaceName;
      const first = created.assignment!;
      expect(first.roleAssignmentId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(first.scope).toEqual(`workspaces/${workspace}`);
      expect(yield* observed(workspace, first.roleAssignmentId)).toEqual(
        `${Azure.Synapse.SynapseRole.ArtifactUser} ${created.principal.objectId} workspaces/${workspace}`,
      );

      // Redeploying the same props changes nothing.
      const again = yield* stack.deploy(
        program({ roleId: Azure.Synapse.SynapseRole.ArtifactUser }),
      );
      expect(again.assignment!.roleAssignmentId).toEqual(first.roleAssignmentId);

      // A new role replaces the assignment.
      const replaced = yield* stack.deploy(
        program({ roleId: Azure.Synapse.SynapseRole.ArtifactPublisher }),
      );
      const second = replaced.assignment!;
      expect(second.roleAssignmentId).not.toEqual(first.roleAssignmentId);
      expect(yield* observed(workspace, second.roleAssignmentId)).toEqual(
        `${Azure.Synapse.SynapseRole.ArtifactPublisher} ${created.principal.objectId} workspaces/${workspace}`,
      );
      expect(yield* untilGone(workspace, first.roleAssignmentId)).toEqual("gone");

      // Removing it from the stack deletes it; the workspace stays.
      yield* stack.deploy(program({}));
      expect(yield* untilGone(workspace, second.roleAssignmentId)).toEqual("gone");

      yield* stack.destroy();
    }).pipe(logLevel, withWorkspaceSlot),
  {
    tags: ["provider:azure", "provider:azure:synapse", "live"],
    timeout: 1_500_000,
  },
);
