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

const getProject = (
  resourceGroupName: string,
  workspaceName: string,
  projectName: string,
) =>
  Effect.gen(function* () {
    return yield* discovery.GetProject({
      subscriptionId: yield* subscription,
      resourceGroupName,
      workspaceName,
      projectName,
    });
  });

const program = (props: {
  withContainer: boolean;
  behaviorPreferences: string;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", { location });
    const identity = yield* Azure.ManagedIdentity.UserAssignedIdentity(
      "Identity",
      { resourceGroup: group.resourceGroupName, location },
    );
    const workspace = yield* Azure.Discovery.Workspace("Workspace", {
      resourceGroup: group.resourceGroupName,
      workspaceIdentity: identity.identityId,
    });
    // The container stays deployed across the replacement step.
    const account = yield* Azure.Storage.StorageAccount("Account", {
      resourceGroup: group.resourceGroupName,
    });
    const container = yield* Azure.Discovery.StorageContainer("Container", {
      resourceGroup: group.resourceGroupName,
      storageStore: {
        kind: "AzureStorageBlob",
        storageAccountId: account.storageAccountId,
      },
    });
    const project = yield* Azure.Discovery.Project("Project", {
      resourceGroup: group.resourceGroupName,
      workspace: workspace.workspaceName,
      storageContainerIds: props.withContainer
        ? [container.storageContainerId]
        : [],
      behaviorPreferences: props.behaviorPreferences,
    });
    return { group, workspace, project };
  });

// Microsoft Discovery is a gated preview: ARM does not expose its resource
// types to the trial subscription (InvalidResourceType, see the probe).
// Needs a workspace (20-40 minutes, roughly $2-5); runs only with
// AZURE_TEST_PAID=1.
// Skipped: failed in the last live run. InvalidResourceType: The resource type could not be found
// in the namespace 'Microsoft.Discovery' for api version '2026-06-01'.
test.provider.skip(
  "create, update, replace, and delete a discovery project",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, workspace, project } = yield* stack.deploy(
        program({ withContainer: false, behaviorPreferences: "concise" }),
      );
      const get = (name: string) =>
        getProject(group.resourceGroupName, workspace.workspaceName, name);
      const observed = yield* get(project.projectName);
      expect(observed.properties?.settings?.behaviorPreferences).toEqual(
        "concise",
      );

      // In place: settings.
      const updated = yield* stack.deploy(
        program({ withContainer: false, behaviorPreferences: "thorough" }),
      );
      expect(updated.project.projectId).toEqual(project.projectId);
      expect(
        (yield* get(project.projectName)).properties?.settings
          ?.behaviorPreferences,
      ).toEqual("thorough");

      // Storage containers are create-only.
      const replaced = yield* stack.deploy(
        program({ withContainer: true, behaviorPreferences: "thorough" }),
      );
      expect(replaced.project.projectName).not.toEqual(project.projectName);
      expect(
        (yield* get(replaced.project.projectName)).properties
          ?.storageContainerIds?.length,
      ).toEqual(1);
      expect(yield* waitGone(get(project.projectName))).toEqual("gone");

      yield* stack.destroy();
      expect(yield* waitGone(get(replaced.project.projectName))).toEqual(
        "gone",
      );
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);

test.provider(
  "discovery projects are rejected where the preview is not enabled",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { group } = yield* stack.deploy(probeGroup);
      const error = yield* discovery
        .ProjectsCreateOrUpdate({
          subscriptionId: yield* subscription,
          resourceGroupName: group.resourceGroupName,
          workspaceName: "alchemy-probe",
          projectName: "alchemy-probe",
          location,
          properties: {},
        })
        .pipe(Effect.flip);
      expect(error._tag).toEqual("InvalidResourceType");
      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 300_000 },
);
