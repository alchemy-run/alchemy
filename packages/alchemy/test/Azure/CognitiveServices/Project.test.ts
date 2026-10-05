import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as cognitiveservices from "@distilled.cloud/azure/cognitiveservices";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const program = (props: {
  name: string;
  displayName: string;
  description: string;
  tags: Record<string, string>;
}) =>
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
      name: props.name,
      displayName: props.displayName,
      description: props.description,
      tags: props.tags,
    });
    return { group, account, project };
  });

// S0 AIServices account + project: $0 idle, ~2 minutes.
test.provider(
  "create, update, replace, and delete a foundry project",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const subscriptionId = yield* subscription;

      const { group, account, project } = yield* stack.deploy(
        program({
          name: "alchemy-project-a",
          displayName: "Alchemy A",
          description: "first",
          tags: { env: "test" },
        }),
      );
      const get = (projectName: string) =>
        cognitiveservices.GetProject({
          subscriptionId,
          resourceGroupName: group.resourceGroupName,
          accountName: account.accountName,
          projectName,
        });
      expect(project.location).toEqual(account.location);
      expect(project.principalId).toBeDefined();
      const observed = yield* get(project.projectName);
      expect(observed.properties?.displayName).toEqual("Alchemy A");
      expect(observed.properties?.description).toEqual("first");
      expect(observed.tags?.env).toEqual("test");
      expect(observed.identity?.type).toEqual("SystemAssigned");

      // In place: display name, description, and tags.
      const updated = yield* stack.deploy(
        program({
          name: "alchemy-project-a",
          displayName: "Alchemy A2",
          description: "second",
          tags: { env: "prod" },
        }),
      );
      expect(updated.project.projectId).toEqual(project.projectId);
      const reobserved = yield* get(project.projectName);
      expect(reobserved.properties?.displayName).toEqual("Alchemy A2");
      expect(reobserved.properties?.description).toEqual("second");
      expect(reobserved.tags?.env).toEqual("prod");

      // Replacement: the name is immutable.
      const replaced = yield* stack.deploy(
        program({
          name: "alchemy-project-b",
          displayName: "Alchemy B",
          description: "third",
          tags: { env: "prod" },
        }),
      );
      expect(replaced.project.projectName).toEqual("alchemy-project-b");
      const replacedObserved = yield* get("alchemy-project-b");
      expect(replacedObserved.properties?.displayName).toEqual("Alchemy B");
      expect(yield* waitGone(get("alchemy-project-a"))).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* waitGone(
          cognitiveservices.GetAccount({
            subscriptionId,
            resourceGroupName: group.resourceGroupName,
            accountName: account.accountName,
          }),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
