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
  target: string;
  key: string;
  metadata: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    // Account-level connections need a Foundry account.
    const account = yield* Azure.CognitiveServices.Account("Account", {
      resourceGroup: group.resourceGroupName,
      allowProjectManagement: true,
      identity: { type: "SystemAssigned" },
    });
    const connection = yield* Azure.CognitiveServices.Connection("Connection", {
      resourceGroup: group.resourceGroupName,
      account: account.accountName,
      name: props.name,
      category: "ApiKey",
      authType: "ApiKey",
      target: props.target,
      credentials: { key: Redacted.make(props.key) },
      metadata: props.metadata,
    });
    return { group, account, connection };
  });

// S0 AIServices account + connection: $0 idle, ~1 minute.
test.provider(
  "create, update, replace, and delete an account connection",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const subscriptionId = yield* subscription;

      const { group, account, connection } = yield* stack.deploy(
        program({
          name: "alchemy-conn-a",
          target: "https://example.com",
          key: "key-one",
          metadata: { purpose: "test" },
        }),
      );
      const get = (connectionName: string) =>
        cognitiveservices.GetAccountConnection({
          subscriptionId,
          resourceGroupName: group.resourceGroupName,
          accountName: account.accountName,
          connectionName,
        });
      expect(connection.authType).toEqual("ApiKey");
      expect(connection.metadata).toEqual({ purpose: "test" });
      const observed = yield* get(connection.connectionName);
      expect(observed.properties.target).toEqual("https://example.com");
      expect(observed.properties.category).toEqual("ApiKey");
      expect(observed.properties.metadata?.["alchemy::id"]).toEqual(
        "Connection",
      );
      const firstHash = observed.properties.metadata?.["alchemy::credentials"];
      expect(firstHash).toBeDefined();

      // In place: target, credentials, and metadata.
      yield* stack.deploy(
        program({
          name: "alchemy-conn-a",
          target: "https://example.org",
          key: "key-two",
          metadata: { purpose: "prod" },
        }),
      );
      const reobserved = yield* get(connection.connectionName);
      expect(reobserved.properties.target).toEqual("https://example.org");
      expect(reobserved.properties.metadata?.purpose).toEqual("prod");
      expect(
        reobserved.properties.metadata?.["alchemy::credentials"],
      ).not.toEqual(firstHash);

      // Replacement: the name is immutable.
      const replaced = yield* stack.deploy(
        program({
          name: "alchemy-conn-b",
          target: "https://example.org",
          key: "key-two",
          metadata: { purpose: "prod" },
        }),
      );
      expect(replaced.connection.connectionName).toEqual("alchemy-conn-b");
      const replacedObserved = yield* get("alchemy-conn-b");
      expect(replacedObserved.properties.target).toEqual("https://example.org");
      expect(yield* waitGone(get("alchemy-conn-a"))).toEqual("gone");

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
