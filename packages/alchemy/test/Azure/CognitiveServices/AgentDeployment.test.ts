import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as cognitiveservices from "@distilled.cloud/azure/cognitiveservices";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

/**
 * Agent deployments need an agent version authored through the Foundry
 * data plane (and a model deployment behind it). Point the test at one with
 * `AZURE_TEST_FOUNDRY_AGENT=<resourceGroup>/<account>/<project>/<agentName>`
 * and `AZURE_TEST_FOUNDRY_AGENT_VERSION=<version>`.
 */
const target = process.env.AZURE_TEST_FOUNDRY_AGENT?.split("/");
const agentVersion = process.env.AZURE_TEST_FOUNDRY_AGENT_VERSION;

const program = (props: { name: string; displayName: string }) =>
  Effect.gen(function* () {
    const [resourceGroup, account, project, agentName] = target!;
    const app = yield* Azure.CognitiveServices.AgentApplication("App", {
      resourceGroup: resourceGroup!,
      account: account!,
      project: project!,
      agents: [{ agentName: agentName! }],
    });
    const deployment = yield* Azure.CognitiveServices.AgentDeployment(
      "Deployment",
      {
        resourceGroup: resourceGroup!,
        account: account!,
        project: project!,
        application: app.applicationName,
        name: props.name,
        deploymentType: "Managed",
        agents: [{ agentName: agentName!, agentVersion: agentVersion! }],
        protocols: [{ protocol: "Responses" }],
        displayName: props.displayName,
      },
    );
    return { app, deployment };
  });

// Preview API on an existing Foundry agent: tokens only, ~2 minutes.
test.provider.skipIf(target?.length !== 4 || agentVersion === undefined)(
  "create, update, replace, and delete an agent deployment",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const subscriptionId = yield* subscription;
      const [resourceGroup, account, project] = target!;

      const { app } = yield* stack.deploy(
        program({ name: "alchemy-agent-a", displayName: "A" }),
      );
      const get = (deploymentName: string) =>
        cognitiveservices.GetAgentDeployment({
          subscriptionId,
          resourceGroupName: resourceGroup!,
          accountName: account!,
          projectName: project!,
          appName: app.applicationName,
          deploymentName,
        });
      expect((yield* get("alchemy-agent-a")).properties.displayName).toEqual(
        "A",
      );

      yield* stack.deploy(
        program({ name: "alchemy-agent-a", displayName: "A2" }),
      );
      expect((yield* get("alchemy-agent-a")).properties.displayName).toEqual(
        "A2",
      );

      yield* stack.deploy(
        program({ name: "alchemy-agent-b", displayName: "B" }),
      );
      expect((yield* get("alchemy-agent-b")).properties.displayName).toEqual(
        "B",
      );
      expect(yield* waitGone(get("alchemy-agent-a"))).toEqual("gone");

      yield* stack.destroy();
      expect(yield* waitGone(get("alchemy-agent-b"))).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
