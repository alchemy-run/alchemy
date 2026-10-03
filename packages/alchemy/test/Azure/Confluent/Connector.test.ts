import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as confluent from "@distilled.cloud/azure/confluent";
import * as storage from "@distilled.cloud/azure/storage";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { runPaidOnly } from "../gates.ts";
import {
  clusterStack,
  logLevel,
  subscription,
  tags,
  waitGone,
} from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

interface Secrets {
  storageAccountKey: string;
  apiKey: string;
  apiSecret: string;
}

const parents = Effect.gen(function* () {
  const base = yield* clusterStack;
  const account = yield* Azure.Storage.StorageAccount("Sink", {
    resourceGroup: base.group.resourceGroupName,
    location: "eastus",
  });
  const container = yield* Azure.Storage.BlobContainer("Orders", {
    resourceGroup: base.group.resourceGroupName,
    storageAccount: account.storageAccountName,
  });
  const topic = yield* Azure.Confluent.Topic("Orders", {
    resourceGroup: base.group.resourceGroupName,
    organization: base.organization.organizationName,
    environment: base.environment.environmentId,
    cluster: base.cluster.clusterId,
    name: "orders",
  });
  return { ...base, account, container, topic };
});

const program = (secrets: Secrets, flushSize: string) =>
  Effect.gen(function* () {
    const p = yield* parents;
    const connector = yield* Azure.Confluent.Connector("BlobSink", {
      resourceGroup: p.group.resourceGroupName,
      organization: p.organization.organizationName,
      environment: p.environment.environmentId,
      cluster: p.cluster.clusterId,
      connectorType: "SINK",
      connectorClass: "AZUREBLOBSINK",
      serviceTypeInfo: {
        connectorServiceType: "AzureBlobStorageSinkConnector",
        storageAccountName: p.account.storageAccountName,
        storageAccountKey: secrets.storageAccountKey,
        storageContainerName: p.container.containerName,
      },
      partnerConnectorInfo: {
        partnerConnectorType: "KafkaAzureBlobStorageSink",
        authType: "KAFKA_API_KEY",
        apiKey: secrets.apiKey,
        apiSecret: secrets.apiSecret,
        topics: ["orders"],
        inputFormat: "JSON",
        outputFormat: "JSON",
        flushSize,
        maxTasks: "1",
        timeInterval: "HOURLY",
      },
    });
    return { ...p, connector };
  });

// Needs a Confluent organization (Marketplace SaaS purchase, blocked on the
// free trial), a Basic cluster, and a managed connector (billed per task
// hour + throughput, ~$0.20 for a short run); ~20 minutes. Run only with
// AZURE_TEST_PAID=1.
test.provider.skipIf(!runPaidOnly)(
  "create, update, and delete a confluent blob sink connector",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const subscriptionId = yield* subscription;

      // Parents first: the connector needs a storage key and a cluster API
      // key, both minted out of band.
      const p = yield* stack.deploy(parents);
      const keys = yield* storage.ListStorageAccountKeys({
        subscriptionId,
        resourceGroupName: p.group.resourceGroupName,
        accountName: p.account.storageAccountName,
      });
      const apiKey = yield* confluent.CreateOrganizationAPIKey({
        subscriptionId,
        resourceGroupName: p.group.resourceGroupName,
        organizationName: p.organization.organizationName,
        environmentId: p.environment.environmentId,
        clusterId: p.cluster.clusterId,
        name: "alchemy-connector-test",
        description: "alchemy Connector test",
      });
      const secret = apiKey.properties?.spec?.secret;
      const secrets: Secrets = {
        storageAccountKey: keys.keys?.[0]?.value ?? "",
        apiKey: apiKey.id ?? "",
        apiSecret:
          secret === undefined
            ? ""
            : typeof secret === "string"
              ? secret
              : Redacted.value(secret),
      };

      const { connector } = yield* stack.deploy(program(secrets, "1000"));
      const getConnector = Effect.gen(function* () {
        return yield* confluent.GetConnector({
          subscriptionId,
          resourceGroupName: connector.resourceGroup,
          organizationName: connector.organization,
          environmentId: connector.environment,
          clusterId: connector.cluster,
          connectorName: connector.connectorName,
        });
      });
      const observed = yield* getConnector;
      expect(observed.properties.connectorBasicInfo?.connectorClass).toEqual(
        "AZUREBLOBSINK",
      );
      expect(connector.connectorState).toBeDefined();

      // In-place: partner settings.
      const updated = yield* stack.deploy(program(secrets, "2000"));
      expect(updated.connector.connectorResourceId).toEqual(
        connector.connectorResourceId,
      );

      yield* stack.destroy();
      expect(yield* waitGone(getConnector)).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
