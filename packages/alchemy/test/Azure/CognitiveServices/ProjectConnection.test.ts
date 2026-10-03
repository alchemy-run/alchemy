import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as cognitiveservices from "@distilled.cloud/azure/cognitiveservices";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const program = (props: {
  name: string;
  keys: Record<string, string>;
  target: string;
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
    });
    const connection = yield* Azure.CognitiveServices.ProjectConnection(
      "Connection",
      {
        resourceGroup: group.resourceGroupName,
        account: account.accountName,
        project: project.projectName,
        name: props.name,
        category: "CustomKeys",
        authType: "CustomKeys",
        target: props.target,
        credentials: {
          keys: Object.fromEntries(
            Object.entries(props.keys).map(([k, v]) => [k, Redacted.make(v)]),
          ),
        },
      },
    );
    return { group, account, project, connection };
  });

// S0 AIServices account + project + connection: $0 idle, ~2 minutes.
test.provider(
  "create, update, replace, and delete a project connection",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const subscriptionId = yield* subscription;

      const { group, account, project, connection } = yield* stack.deploy(
        program({
          name: "alchemy-pconn-a",
          keys: { "x-api-key": "one" },
          target: "https://example.com",
        }),
      );
      const get = (connectionName: string) =>
        cognitiveservices.GetProjectConnection({
          subscriptionId,
          resourceGroupName: group.resourceGroupName,
          accountName: account.accountName,
          projectName: project.projectName,
          connectionName,
        });
      expect(connection.authType).toEqual("CustomKeys");
      const observed = yield* get(connection.connectionName);
      expect(observed.properties.category).toEqual("CustomKeys");
      expect(observed.properties.target).toEqual("https://example.com");
      const firstHash = observed.properties.metadata?.["alchemy::credentials"];
      expect(firstHash).toBeDefined();

      // In place: target and credentials.
      yield* stack.deploy(
        program({
          name: "alchemy-pconn-a",
          keys: { "x-api-key": "two" },
          target: "https://example.org",
        }),
      );
      const reobserved = yield* get(connection.connectionName);
      expect(reobserved.properties.target).toEqual("https://example.org");
      expect(
        reobserved.properties.metadata?.["alchemy::credentials"],
      ).not.toEqual(firstHash);

      // Replacement: the name is immutable.
      const replaced = yield* stack.deploy(
        program({
          name: "alchemy-pconn-b",
          keys: { "x-api-key": "two" },
          target: "https://example.org",
        }),
      );
      expect(replaced.connection.connectionName).toEqual("alchemy-pconn-b");
      expect((yield* get("alchemy-pconn-b")).properties.authType).toEqual(
        "CustomKeys",
      );
      expect(yield* waitGone(get("alchemy-pconn-a"))).toEqual("gone");

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
