import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as cognitiveservices from "@distilled.cloud/azure/cognitiveservices";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const program = (props: { aiServicesConnections?: string[] }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const account = yield* Azure.CognitiveServices.Account("Foundry", {
      resourceGroup: group.resourceGroupName,
      allowProjectManagement: true,
      identity: { type: "SystemAssigned" },
    });
    const project = yield* Azure.CognitiveServices.Project("Project", {
      resourceGroup: group.resourceGroupName,
      account: account.accountName,
    });
    // Project hosts need the account's capability host first; taking the
    // account name from it orders the deploy.
    const accountHost = yield* Azure.CognitiveServices.CapabilityHost(
      "AccountAgents",
      {
        resourceGroup: group.resourceGroupName,
        account: account.accountName,
      },
    );
    const host = yield* Azure.CognitiveServices.ProjectCapabilityHost(
      "Agents",
      {
        resourceGroup: group.resourceGroupName,
        account: accountHost.account,
        project: project.projectName,
        name: "alchemy-project-host",
        aiServicesConnections: props.aiServicesConnections,
      },
    );
    return { group, account, project, host };
  });

// Basic agent setup on an S0 Foundry account + project: $0 idle, ~2 minutes.
test.provider(
  "create and delete a project capability host",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const subscriptionId = yield* subscription;

      const { group, account, project, host } = yield* stack.deploy(
        program({}),
      );
      const get = () =>
        cognitiveservices.GetProjectCapabilityHost({
          subscriptionId,
          resourceGroupName: group.resourceGroupName,
          accountName: account.accountName,
          projectName: project.projectName,
          capabilityHostName: host.capabilityHostName,
        });
      const observed = yield* get();
      expect(observed.properties.provisioningState).toEqual("Succeeded");
      expect(observed.properties.aiServicesConnections ?? []).toEqual([]);

      // Re-deploying the same settings is a no-op (hosts are immutable).
      const again = yield* stack.deploy(program({}));
      expect(again.host.capabilityHostId).toEqual(host.capabilityHostId);

      yield* stack.destroy();
      expect(yield* waitGone(get())).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
