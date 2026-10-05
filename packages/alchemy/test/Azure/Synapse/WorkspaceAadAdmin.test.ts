import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as synapse from "@distilled.cloud/azure/synapse";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { lakeWorkspace, logLevel, withWorkspaceSlot } from "./fixture.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getAdmin = (resourceGroupName: string, workspaceName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* synapse.GetWorkspaceAadAdmin({
      subscriptionId,
      resourceGroupName,
      workspaceName,
    });
  });

/** An unset administrator is either a 404 or an empty shell. */
const adminCleared = (resourceGroupName: string, workspaceName: string) =>
  getAdmin(resourceGroupName, workspaceName).pipe(
    Effect.map((admin) => (admin.properties?.sid ? "set" : "cleared")),
    Effect.catchTag(["ResourceNotFound", "NotFound"], () =>
      Effect.succeed("cleared" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (status) => status === "cleared",
      times: 24,
    }),
  );

const program = (props: { admin: "First" | "Second" | "None" }) =>
  Effect.gen(function* () {
    const { group, workspace } = yield* lakeWorkspace();
    const first = yield* Azure.ManagedIdentity.UserAssignedIdentity("First", {
      resourceGroup: group.resourceGroupName,
    });
    const second = yield* Azure.ManagedIdentity.UserAssignedIdentity("Second", {
      resourceGroup: group.resourceGroupName,
    });
    if (props.admin === "None") return { group, workspace, first, second };
    const chosen = props.admin === "First" ? first : second;
    const admin = yield* Azure.Synapse.WorkspaceAadAdmin("Admin", {
      resourceGroup: group.resourceGroupName,
      workspace: workspace.workspaceName,
      login: chosen.identityName,
      sid: chosen.principalId,
    });
    return { group, workspace, first, second, admin };
  });

// Free; the workspace takes ~3-8 min.
test.provider(
  "set, change, and remove a synapse workspace entra administrator",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(program({ admin: "First" }));
      const rg = created.group.resourceGroupName;
      const ws = created.workspace.workspaceName;
      expect(created.admin?.login).toEqual(created.first.identityName);
      const observed = yield* getAdmin(rg, ws);
      expect(observed.properties?.sid?.toLowerCase()).toEqual(
        created.first.principalId.toLowerCase(),
      );

      // In place: switch to the second identity.
      const updated = yield* stack.deploy(program({ admin: "Second" }));
      expect(updated.admin?.administratorId).toEqual(
        created.admin?.administratorId,
      );
      const reobserved = yield* getAdmin(rg, ws);
      expect(reobserved.properties?.login).toEqual(updated.second.identityName);

      // Removing the administrator from the stack clears it.
      yield* stack.deploy(program({ admin: "None" }));
      expect(yield* adminCleared(rg, ws)).toEqual("cleared");

      yield* stack.destroy();
    }).pipe(withWorkspaceSlot, logLevel),
  {
    tags: ["provider:azure", "provider:azure:synapse", "live"],
    timeout: 900_000,
  },
);
