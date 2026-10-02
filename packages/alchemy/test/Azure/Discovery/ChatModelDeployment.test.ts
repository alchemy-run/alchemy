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

const getDeployment = (
  resourceGroupName: string,
  workspaceName: string,
  chatModelDeploymentName: string,
) =>
  Effect.gen(function* () {
    return yield* discovery.GetChatModelDeployment({
      subscriptionId: yield* subscription,
      resourceGroupName,
      workspaceName,
      chatModelDeploymentName,
    });
  });

const program = (props: { modelName: string; capacity: number }) =>
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
    const deployment = yield* Azure.Discovery.ChatModelDeployment("Chat", {
      resourceGroup: group.resourceGroupName,
      workspace: workspace.workspaceName,
      modelFormat: "OpenAI",
      modelName: props.modelName,
      skuName: "GlobalStandard",
      capacity: props.capacity,
    });
    return { group, workspace, deployment };
  });

// Microsoft Discovery is a gated preview: ARM does not expose its resource
// types to the trial subscription (InvalidResourceType, see the probe).
// Needs a workspace (20-40 minutes, roughly $2-5) and Azure OpenAI quota;
// a pay-per-token deployment is ~$0 idle. Runs only with AZURE_TEST_PAID=1.
test.provider.skipIf(!runPaidOnly)(
  "create, update, replace, and delete a discovery chat model deployment",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, workspace, deployment } = yield* stack.deploy(
        program({ modelName: "gpt-4o-mini", capacity: 1 }),
      );
      const get = (name: string) =>
        getDeployment(group.resourceGroupName, workspace.workspaceName, name);
      const observed = yield* get(deployment.chatModelDeploymentName);
      expect(observed.properties?.modelName).toEqual("gpt-4o-mini");
      expect(observed.properties?.capacity).toEqual(1);

      // In place: capacity.
      const updated = yield* stack.deploy(
        program({ modelName: "gpt-4o-mini", capacity: 2 }),
      );
      expect(updated.deployment.chatModelDeploymentId).toEqual(
        deployment.chatModelDeploymentId,
      );
      expect(
        (yield* get(deployment.chatModelDeploymentName)).properties?.capacity,
      ).toEqual(2);

      // The model is create-only.
      const replaced = yield* stack.deploy(
        program({ modelName: "gpt-4o", capacity: 2 }),
      );
      expect(replaced.deployment.chatModelDeploymentName).not.toEqual(
        deployment.chatModelDeploymentName,
      );
      expect(yield* waitGone(get(deployment.chatModelDeploymentName))).toEqual(
        "gone",
      );

      yield* stack.destroy();
      expect(
        yield* waitGone(get(replaced.deployment.chatModelDeploymentName)),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);

test.provider(
  "discovery chat model deployments are rejected where the preview is not enabled",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { group } = yield* stack.deploy(probeGroup);
      const error = yield* discovery
        .ChatModelDeploymentsCreateOrUpdate({
          subscriptionId: yield* subscription,
          resourceGroupName: group.resourceGroupName,
          workspaceName: "alchemy-probe",
          chatModelDeploymentName: "alchemy-probe",
          location,
          properties: { modelFormat: "OpenAI", modelName: "gpt-4o-mini" },
        })
        .pipe(Effect.flip);
      expect(error._tag).toEqual("InvalidResourceType");
      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 300_000 },
);
