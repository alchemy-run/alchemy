import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as hci from "@distilled.cloud/azure/azurestackhci";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runPaidOnly } from "../gates.ts";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getExtension = (
  resourceGroupName: string,
  clusterName: string,
  extensionName: string,
) =>
  Effect.gen(function* () {
    return yield* hci.GetExtension({
      subscriptionId: yield* subscription,
      resourceGroupName,
      clusterName,
      arcSettingName: "default",
      extensionName,
    });
  });

// An existing, registered Azure Local cluster (with Arc-connected nodes).
const clusterGroup = () => process.env.AZURE_TEST_HCI_CLUSTER_GROUP ?? "";
const clusterName = () => process.env.AZURE_TEST_HCI_CLUSTER ?? "";

const program = (props: {
  publisher: string;
  type: string;
  enableAutomaticUpgrade: boolean;
}) =>
  Effect.gen(function* () {
    const extension = yield* Azure.AzureStackHCI.Extension("Extension", {
      resourceGroup: clusterGroup(),
      cluster: clusterName(),
      arcSetting: "default",
      publisher: props.publisher,
      type: props.type,
      autoUpgradeMinorVersion: true,
      enableAutomaticUpgrade: props.enableAutomaticUpgrade,
    });
    return { extension };
  });

// Installs onto every node of a registered Azure Local cluster (needs real
// hardware; the free trial has none). Run with AZURE_TEST_PAID=1,
// AZURE_TEST_HCI_CLUSTER_GROUP and AZURE_TEST_HCI_CLUSTER.
test.provider.skipIf(!runPaidOnly)(
  "create, update, replace, and delete an Azure Local extension",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { extension } = yield* stack.deploy(
        program({
          publisher: "Microsoft.Azure.Monitor",
          type: "AzureMonitorWindowsAgent",
          enableAutomaticUpgrade: false,
        }),
      );
      const get = (name: string) =>
        getExtension(clusterGroup(), clusterName(), name);
      const observed = yield* get(extension.extensionName);
      expect(observed.properties?.extensionParameters?.type).toEqual(
        "AzureMonitorWindowsAgent",
      );

      // In place: automatic upgrades.
      yield* stack.deploy(
        program({
          publisher: "Microsoft.Azure.Monitor",
          type: "AzureMonitorWindowsAgent",
          enableAutomaticUpgrade: true,
        }),
      );
      const reobserved = yield* get(extension.extensionName);
      expect(
        reobserved.properties?.extensionParameters?.enableAutomaticUpgrade,
      ).toEqual(true);

      // Replacement: a different extension type.
      const replaced = yield* stack.deploy(
        program({
          publisher: "Microsoft.EnterpriseCloud.Monitoring",
          type: "MicrosoftMonitoringAgent",
          enableAutomaticUpgrade: true,
        }),
      );
      expect(yield* waitGone(get(extension.extensionName))).toEqual("gone");

      yield* stack.destroy();
      expect(yield* waitGone(get(replaced.extension.extensionName))).toEqual(
        "gone",
      );
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);

// Ungated probe (free): an unregistered cluster record has no Arc nodes to
// install onto, so Azure rejects the extension. The service returns a
// code-less 400, surfaced as the status-derived `BadRequest`.
test.provider(
  "an unregistered cluster rejects extensions",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, cluster, arc } = yield* stack.deploy(
        Effect.gen(function* () {
          const group = yield* Azure.Resources.ResourceGroup("Group", {
            location: "eastus",
          });
          const cluster = yield* Azure.AzureStackHCI.Cluster("Cluster", {
            resourceGroup: group.resourceGroupName,
          });
          const arc = yield* Azure.AzureStackHCI.ArcSetting("Arc", {
            resourceGroup: group.resourceGroupName,
            cluster: cluster.clusterName,
            arcInstanceResourceGroup: group.resourceGroupName,
          });
          return { group, cluster, arc };
        }),
      );
      const error = yield* hci
        .CreateExtension({
          subscriptionId: yield* subscription,
          resourceGroupName: group.resourceGroupName,
          clusterName: cluster.clusterName,
          arcSettingName: arc.arcSettingName,
          extensionName: "AzureMonitorWindowsAgent",
          properties: {
            extensionParameters: {
              publisher: "Microsoft.Azure.Monitor",
              type: "AzureMonitorWindowsAgent",
              autoUpgradeMinorVersion: true,
            },
          },
        })
        .pipe(Effect.flip);
      expect(error._tag).toEqual("BadRequest");
      expect(error.message).toContain("resource validation failed");
      const getError = yield* getExtension(
        group.resourceGroupName,
        cluster.clusterName,
        "AzureMonitorWindowsAgent",
      ).pipe(Effect.flip);
      expect(getError._tag).toEqual("ResourceNotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
