import * as Azure from "@alchemy.run/azure";
import { ensureRegistered } from "@alchemy.run/azure/Arm";
import * as purview from "@distilled.cloud/azure/purview";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import { runPaidOnly } from "../gates.ts";
import { getKafkaConfiguration, gone, location, logLevel, subscriptionId, tags } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

/** Built-in role GUIDs Purview's identity needs on the event hubs. */
const EventHubsDataSender = "2b629674-e913-4c01-ae53-ef4638d8f975";
const EventHubsDataReceiver = "a638d3c7-ab3a-418d-83e6-5f17a39d4fde";

const program = (props: { kind: "Notification" | "Hook"; name?: string }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", { location });
    const account = yield* Azure.Purview.Account("Catalog", {
      resourceGroup: group.resourceGroupName,
      location,
      managedEventHubState: "Disabled",
    });
    const namespace = yield* Azure.EventHub.Namespace("Events", {
      resourceGroup: group.resourceGroupName,
      location,
    });
    const notifications = yield* Azure.EventHub.EventHub("Notifications", {
      resourceGroup: group.resourceGroupName,
      namespace: namespace.namespaceName,
      partitionCount: 1,
    });
    const hooks = yield* Azure.EventHub.EventHub("Hooks", {
      resourceGroup: group.resourceGroupName,
      namespace: namespace.namespaceName,
      partitionCount: 1,
    });
    const consumers = yield* Azure.EventHub.ConsumerGroup("Purview", {
      resourceGroup: group.resourceGroupName,
      namespace: namespace.namespaceName,
      eventHub: hooks.eventHubName,
    });
    yield* Azure.Authorization.RoleAssignment("CatalogSends", {
      scope: notifications.eventHubId,
      roleDefinitionId: EventHubsDataSender,
      principalId: account.principalId.as<string>(),
      principalType: "ServicePrincipal",
    });
    yield* Azure.Authorization.RoleAssignment("CatalogReceives", {
      scope: hooks.eventHubId,
      roleDefinitionId: EventHubsDataReceiver,
      principalId: account.principalId.as<string>(),
      principalType: "ServicePrincipal",
    });
    const configuration = yield* Azure.Purview.KafkaConfiguration("Kafka", {
      resourceGroup: group.resourceGroupName,
      account: account.accountName,
      name: props.name,
      eventHubId: props.kind === "Notification" ? notifications.eventHubId : hooks.eventHubId,
      eventHubType: props.kind,
      consumerGroup: props.kind === "Hook" ? consumers.consumerGroupName : undefined,
    });
    return { group, account, notifications, hooks, consumers, configuration };
  });

// ~$1/run (a Purview account billed per Data Map capacity unit hour, plus a
// Standard Event Hubs namespace), 20-30 min. It creates a Purview account,
// which a tenant can do only once (see Account.test.ts). Run only with
// AZURE_TEST_PAID=1 on a tenant set aside for it.
test.provider.skipIf(!runPaidOnly)(
  "create, update, replace, and delete a purview kafka configuration",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(program({ kind: "Notification" }));
      const rg = created.group.resourceGroupName;
      const account = created.account.accountName;
      const first = created.configuration;
      expect(first.eventHubType).toEqual("Notification");
      expect(first.eventHubId?.toLowerCase()).toEqual(
        created.notifications.eventHubId.toLowerCase(),
      );
      const observed = yield* getKafkaConfiguration(rg, account, first.kafkaConfigurationName);
      expect(observed.properties?.eventHubType).toEqual("Notification");
      expect(observed.properties?.eventStreamingState).toEqual("Enabled");
      expect(observed.properties?.credentials?.type).toEqual("SystemAssigned");

      // In place: switch to a hook event hub with a consumer group.
      const updated = yield* stack.deploy(program({ kind: "Hook" }));
      expect(updated.configuration.kafkaConfigurationName).toEqual(first.kafkaConfigurationName);
      const hook = yield* getKafkaConfiguration(rg, account, first.kafkaConfigurationName);
      expect(hook.properties?.eventHubType).toEqual("Hook");
      expect(hook.properties?.consumerGroup).toEqual(updated.consumers.consumerGroupName);
      expect(hook.properties?.eventHubResourceId?.toLowerCase()).toEqual(
        updated.hooks.eventHubId.toLowerCase(),
      );

      // Replacement: the name is the configuration's identity.
      const replaced = yield* stack.deploy(
        program({ kind: "Hook", name: "alchemy-kafka-renamed" }),
      );
      expect(replaced.configuration.kafkaConfigurationName).toEqual("alchemy-kafka-renamed");
      expect(yield* gone(getKafkaConfiguration(rg, account, first.kafkaConfigurationName))).toEqual(
        "gone",
      );

      yield* stack.destroy();
      expect(yield* gone(getKafkaConfiguration(rg, account, "alchemy-kafka-renamed"))).toEqual(
        "gone",
      );
    }).pipe(logLevel),
  { tags, timeout: 3_600_000 },
);

// Probe: a configuration whose account is gone reads as the typed
// `ResourceNotFound` (ARM code `ParentResourceNotFound`) that `read` and
// `delete` treat as gone.
test.provider(
  "a kafka configuration of a missing account reads as ResourceNotFound",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { group } = yield* stack.deploy(
        Effect.gen(function* () {
          const group = yield* Azure.Resources.ResourceGroup("Group", { location });
          return { group };
        }),
      );
      const subscription = yield* subscriptionId;
      yield* ensureRegistered(subscription, "Microsoft.Purview");
      const where = {
        subscriptionId: subscription,
        resourceGroupName: group.resourceGroupName,
        accountName: "alchemy-purview-missing",
        kafkaConfigurationName: "alchemy-kafka-missing",
      };
      const readError = yield* purview.GetKafkaConfiguration(where).pipe(Effect.flip);
      expect(readError._tag).toEqual("ResourceNotFound");
      const deleteError = yield* purview.DeleteKafkaConfiguration(where).pipe(Effect.flip);
      expect(deleteError._tag).toEqual("ResourceNotFound");
      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 300_000 },
);
