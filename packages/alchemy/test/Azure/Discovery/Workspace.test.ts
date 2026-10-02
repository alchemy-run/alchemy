import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as discovery from "@distilled.cloud/azure/discovery";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runPaidOnly } from "../gates.ts";
import {
  location,
  logLevel,
  probeGroup,
  subscription,
  tags,
  waitGone,
} from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getWorkspace = (resourceGroupName: string, workspaceName: string) =>
  Effect.gen(function* () {
    return yield* discovery.GetWorkspace({
      subscriptionId: yield* subscription,
      resourceGroupName,
      workspaceName,
    });
  });

const program = (props: {
  location: string;
  publicNetworkAccess: "Enabled" | "Disabled";
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", { location });
    const identity = yield* Azure.ManagedIdentity.UserAssignedIdentity(
      "Identity",
      { resourceGroup: group.resourceGroupName, location },
    );
    const workspace = yield* Azure.Discovery.Workspace("Workspace", {
      resourceGroup: group.resourceGroupName,
      location: props.location,
      workspaceIdentity: identity.identityId,
      publicNetworkAccess: props.publicNetworkAccess,
      tags: props.tags,
    });
    return { group, workspace };
  });

// Microsoft Discovery is a gated preview: ARM does not expose its resource
// types to the trial subscription (InvalidResourceType, see the probe).
// A workspace provisions a managed resource group (AI Foundry, search,
// storage, Cosmos DB): roughly $2-5 and 20-40 minutes per provisioning,
// twice across the replacement; runs only with AZURE_TEST_PAID=1.
test.provider.skipIf(!runPaidOnly)(
  "create, update, replace, and delete a discovery workspace",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, workspace } = yield* stack.deploy(
        program({
          location,
          publicNetworkAccess: "Enabled",
          tags: { env: "test" },
        }),
      );
      const get = (name: string) => getWorkspace(group.resourceGroupName, name);
      const observed = yield* get(workspace.workspaceName);
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.tags?.env).toEqual("test");

      // In place: public network access and tags.
      const updated = yield* stack.deploy(
        program({
          location,
          publicNetworkAccess: "Disabled",
          tags: { env: "prod" },
        }),
      );
      expect(updated.workspace.workspaceId).toEqual(workspace.workspaceId);
      const reobserved = yield* get(workspace.workspaceName);
      expect(reobserved.properties?.publicNetworkAccess).toEqual("Disabled");
      expect(reobserved.tags?.env).toEqual("prod");

      // A location change replaces the workspace.
      const replaced = yield* stack.deploy(
        program({
          location: "eastus2",
          publicNetworkAccess: "Disabled",
          tags: { env: "prod" },
        }),
      );
      expect(replaced.workspace.workspaceName).not.toEqual(
        workspace.workspaceName,
      );
      expect(yield* waitGone(get(workspace.workspaceName))).toEqual("gone");

      yield* stack.destroy();
      expect(yield* waitGone(get(replaced.workspace.workspaceName))).toEqual(
        "gone",
      );
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);

test.provider(
  "discovery workspaces are rejected where the preview is not enabled",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { group } = yield* stack.deploy(probeGroup);
      const subscriptionId = yield* subscription;
      const error = yield* discovery
        .WorkspacesCreateOrUpdate({
          subscriptionId,
          resourceGroupName: group.resourceGroupName,
          workspaceName: "alchemy-probe",
          location,
          properties: {
            workspaceIdentity: {
              id: `/subscriptions/${subscriptionId}/resourceGroups/${group.resourceGroupName}/providers/Microsoft.ManagedIdentity/userAssignedIdentities/alchemy-probe`,
            },
          },
        })
        .pipe(Effect.flip);
      expect(error._tag).toEqual("InvalidResourceType");
      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 300_000 },
);
