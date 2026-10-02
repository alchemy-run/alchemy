import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as ml from "@distilled.cloud/azure/machinelearningservices";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  baseWorkspace,
  location,
  logLevel,
  subscription,
  tags,
  waitGone,
} from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getWorkspace = (resourceGroupName: string, workspaceName: string) =>
  Effect.gen(function* () {
    return yield* ml.GetWorkspace({
      subscriptionId: yield* subscription,
      resourceGroupName,
      workspaceName,
    });
  });

const program = (props: {
  friendlyName: string;
  description?: string;
  tags: Record<string, string>;
  name?: string;
}) =>
  Effect.gen(function* () {
    const base = yield* baseWorkspace({
      friendlyName: props.friendlyName,
      description: props.description,
      tags: props.tags,
      name: props.name,
    });
    const project = yield* Azure.MachineLearning.Workspace("Project", {
      resourceGroup: base.group.resourceGroupName,
      location,
      kind: "Project",
      hubResourceId: base.workspace.workspaceId,
      friendlyName: "Project",
    });
    return { ...base, project };
  });

// Hub and project workspaces have no hourly charge (storage + Key Vault
// cost cents); ~4-8 minutes including a replacement.
test.provider(
  "create, update, replace, and delete a machine learning hub and project",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, workspace, project } = yield* stack.deploy(
        program({ friendlyName: "Research", tags: { env: "test" } }),
      );
      expect(workspace.workspaceName).toMatch(/^[a-z0-9][a-z0-9_-]{2,32}$/);
      expect(workspace.kind).toEqual("Hub");
      expect(workspace.principalId).toBeTruthy();
      expect(project.kind).toEqual("Project");
      const observed = yield* getWorkspace(
        group.resourceGroupName,
        workspace.workspaceName,
      );
      expect(observed.properties.provisioningState).toEqual("Succeeded");
      expect(observed.properties.friendlyName).toEqual("Research");
      expect(observed.identity?.type).toEqual("SystemAssigned");
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("Workspace");
      const observedProject = yield* getWorkspace(
        group.resourceGroupName,
        project.workspaceName,
      );
      expect(observedProject.properties.hubResourceId?.toLowerCase()).toEqual(
        workspace.workspaceId.toLowerCase(),
      );

      // In-place: display name, description, and tags.
      const updated = yield* stack.deploy(
        program({
          friendlyName: "Research v2",
          description: "Updated by alchemy",
          tags: { env: "prod" },
        }),
      );
      expect(updated.workspace.workspaceId).toEqual(workspace.workspaceId);
      expect(updated.workspace.mlWorkspaceId).toEqual(workspace.mlWorkspaceId);
      const reobserved = yield* getWorkspace(
        group.resourceGroupName,
        workspace.workspaceName,
      );
      expect(reobserved.properties.friendlyName).toEqual("Research v2");
      expect(reobserved.properties.description).toEqual("Updated by alchemy");
      expect(reobserved.tags?.env).toEqual("prod");

      // Replacement: an explicit new hub name; the project follows its hub.
      const replaced = yield* stack.deploy(
        program({
          name: `${workspace.workspaceName.slice(0, 28)}-r2`,
          friendlyName: "Research v2",
          tags: { env: "prod" },
        }),
      );
      expect(replaced.workspace.workspaceName).not.toEqual(
        workspace.workspaceName,
      );
      const replacedObserved = yield* getWorkspace(
        group.resourceGroupName,
        replaced.workspace.workspaceName,
      );
      expect(replacedObserved.properties.provisioningState).toEqual(
        "Succeeded",
      );
      expect(
        yield* waitGone(
          getWorkspace(group.resourceGroupName, workspace.workspaceName),
        ),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* waitGone(
          getWorkspace(
            group.resourceGroupName,
            replaced.workspace.workspaceName,
          ),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);

// Ungated probe: a `Default` workspace without Application Insights is
// rejected with the typed error (Alchemy cannot create Application
// Insights components yet, so `Default` lifecycles need an existing one).
test.provider(
  "a Default workspace without Application Insights is rejected",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { group, storage, vault } = yield* stack.deploy(
        Effect.gen(function* () {
          const group = yield* Azure.Resources.ResourceGroup("Group", {
            location,
          });
          const storage = yield* Azure.Storage.StorageAccount("Artifacts", {
            resourceGroup: group.resourceGroupName,
            location,
          });
          const vault = yield* Azure.KeyVault.Vault("Secrets", {
            resourceGroup: group.resourceGroupName,
            location,
            enableRbacAuthorization: false,
            softDeleteRetentionInDays: 7,
          });
          return { group, storage, vault };
        }),
      );
      const error = yield* ml
        .WorkspacesCreateOrUpdate({
          subscriptionId: yield* subscription,
          resourceGroupName: group.resourceGroupName,
          workspaceName: "probe-default",
          location,
          kind: "Default",
          identity: { type: "SystemAssigned" },
          properties: {
            storageAccount: storage.storageAccountId,
            keyVault: vault.vaultId,
          },
        })
        .pipe(Effect.flip);
      expect(error._tag).toEqual("MachineLearningWorkspaceMissingDependencies");
      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
