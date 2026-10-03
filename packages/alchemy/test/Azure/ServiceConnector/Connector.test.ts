import * as Azure from "@/Azure";
import * as Output from "@/Output";
import * as Test from "@/Test/Alchemy";
import * as servicelinker from "@distilled.cloud/azure/servicelinker";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Azure.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const getConnector = (attrs: {
  resourceGroup: string;
  location: string;
  connectorName: string;
}) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* servicelinker.GetConnector({
      subscriptionId,
      resourceGroupName: attrs.resourceGroup,
      location: attrs.location,
      connectorName: attrs.connectorName,
    });
  });

const connectorGone = (attrs: {
  resourceGroup: string;
  location: string;
  connectorName: string;
}) =>
  getConnector(attrs).pipe(
    Effect.as("found" as const),
    Effect.catchTag(
      ["ResourceNotFound", "ResourceGroupNotFound", "NotFound"],
      () => Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (status) => status === "gone",
      times: 12,
    }),
  );

const program = (props: {
  service: "blobServices" | "queueServices";
  clientType: Azure.ServiceConnector.ConnectionClientType;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const account = yield* Azure.Storage.StorageAccount("Account", {
      resourceGroup: group.resourceGroupName,
    });
    const connector = yield* Azure.ServiceConnector.Connector("Connector", {
      resourceGroup: group.resourceGroupName,
      location: "eastus",
      targetService: {
        type: "AzureResource",
        id: Output.interpolate`${account.storageAccountId}/${props.service}/default`,
      },
      authInfo: { authType: "secret" },
      clientType: props.clientType,
    });
    return { group, account, connector };
  });

// Cost: ~$0 (empty Standard_LRS account; connectors are free). ~1-2 minutes.
test.provider(
  "create, update, replace, and delete a service connector",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { account, connector } = yield* stack.deploy(
        program({ service: "blobServices", clientType: "nodejs" }),
      );
      expect(connector.connectorName).toMatch(/^[A-Za-z0-9._]+$/);
      expect(connector.targetType).toEqual("AzureResource");
      expect(connector.target.toLowerCase()).toEqual(
        `${account.storageAccountId}/blobServices/default`.toLowerCase(),
      );
      const observed = yield* getConnector(connector);
      expect(observed.properties.clientType).toEqual("nodejs");
      expect(observed.properties.authInfo?.authType).toEqual("secret");

      // In-place update: client type.
      const updated = yield* stack.deploy(
        program({ service: "blobServices", clientType: "python" }),
      );
      expect(updated.connector.connectorName).toEqual(connector.connectorName);
      expect(updated.connector.clientType).toEqual("python");
      const reobserved = yield* getConnector(connector);
      expect(reobserved.properties.clientType).toEqual("python");

      // Replacement: a different target is a new connection.
      const replaced = yield* stack.deploy(
        program({ service: "queueServices", clientType: "python" }),
      );
      expect(replaced.connector.connectorName).not.toEqual(
        connector.connectorName,
      );
      expect(replaced.connector.target.toLowerCase()).toContain(
        "/queueservices/default",
      );
      expect(yield* connectorGone(connector)).toEqual("gone");

      yield* stack.destroy();
      expect(yield* connectorGone(replaced.connector)).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:serviceconnector", "live"],
    timeout: 600_000,
  },
);
