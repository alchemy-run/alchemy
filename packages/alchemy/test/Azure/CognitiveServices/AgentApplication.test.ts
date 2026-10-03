import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as cognitiveservices from "@distilled.cloud/azure/cognitiveservices";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

/**
 * Agent applications publish agents that already exist in a Foundry
 * project; agents are authored through the Foundry data plane, which this
 * suite does not drive. Point the test at an existing agent with
 * `AZURE_TEST_FOUNDRY_AGENT=<resourceGroup>/<account>/<project>/<agentName>`.
 * Without agents Azure rejects the PUT ("Agents cannot be null or empty");
 * with an unknown agent it answers 404 "SystemError".
 */
const target = process.env.AZURE_TEST_FOUNDRY_AGENT?.split("/");

const program = (props: { name: string; displayName: string }) =>
  Effect.gen(function* () {
    const [resourceGroup, account, project, agentName] = target!;
    const app = yield* Azure.CognitiveServices.AgentApplication("App", {
      resourceGroup: resourceGroup!,
      account: account!,
      project: project!,
      name: props.name,
      displayName: props.displayName,
      agents: [{ agentName: agentName! }],
      tags: { env: "test" },
    });
    return { app };
  });

// Preview API on an existing Foundry project: $0, ~1 minute.
test.provider.skipIf(target?.length !== 4)(
  "create, update, replace, and delete an agent application",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const subscriptionId = yield* subscription;
      const [resourceGroup, account, project] = target!;
      const get = (name: string) =>
        cognitiveservices.GetAgentApplication({
          subscriptionId,
          resourceGroupName: resourceGroup!,
          accountName: account!,
          projectName: project!,
          name,
        });

      yield* stack.deploy(
        program({ name: "alchemy-app-a", displayName: "Alchemy A" }),
      );
      expect((yield* get("alchemy-app-a")).properties.displayName).toEqual(
        "Alchemy A",
      );

      // In place: display name.
      yield* stack.deploy(
        program({ name: "alchemy-app-a", displayName: "Alchemy A2" }),
      );
      expect((yield* get("alchemy-app-a")).properties.displayName).toEqual(
        "Alchemy A2",
      );

      // Replacement: the name is immutable.
      yield* stack.deploy(
        program({ name: "alchemy-app-b", displayName: "Alchemy B" }),
      );
      expect((yield* get("alchemy-app-b")).properties.displayName).toEqual(
        "Alchemy B",
      );
      expect(yield* waitGone(get("alchemy-app-a"))).toEqual("gone");

      yield* stack.destroy();
      expect(yield* waitGone(get("alchemy-app-b"))).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
