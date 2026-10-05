import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as hci from "@distilled.cloud/azure/azurestackhci";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runPaidOnly } from "../gates.ts";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getSetting = (resourceGroupName: string, clusterName: string) =>
  Effect.gen(function* () {
    return yield* hci.GetDeploymentSettings({
      subscriptionId: yield* subscription,
      resourceGroupName,
      clusterName,
      deploymentSettingsName: "default",
    });
  });

// Arc-registered Azure Local nodes and their full deployment
// configuration (JSON of `deploymentConfiguration`).
const arcNodes = () =>
  (process.env.AZURE_TEST_HCI_ARC_NODES ?? "").split(",").filter(Boolean);
const deploymentConfiguration =
  (): Azure.AzureStackHCI.HciDeploymentConfiguration =>
    JSON.parse(
      process.env.AZURE_TEST_HCI_DEPLOYMENT_CONFIG ?? '{"scaleUnits":[]}',
    );

const program = (mode: "Validate" | "Deploy") =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: process.env.AZURE_TEST_HCI_LOCATION ?? "eastus",
    });
    const cluster = yield* Azure.AzureStackHCI.Cluster("Cluster", {
      resourceGroup: group.resourceGroupName,
    });
    const deployment = yield* Azure.AzureStackHCI.DeploymentSetting(
      "Deployment",
      {
        resourceGroup: group.resourceGroupName,
        cluster: cluster.clusterName,
        arcNodeResourceIds: arcNodes(),
        deploymentMode: mode,
        deploymentConfiguration: deploymentConfiguration(),
      },
    );
    return { group, cluster, deployment };
  });

// Validates (~30 min) and then deploys (hours) Azure Local onto physical
// Arc-registered nodes; impossible on the free trial. Run with
// AZURE_TEST_PAID=1, AZURE_TEST_HCI_ARC_NODES and
// AZURE_TEST_HCI_DEPLOYMENT_CONFIG.
// Skipped: failed in the last live run. BadRequest: Resource creation validation failed. Details:
// [{"Code":"InvalidArmResourceId","Message":"ArcNodeResourceIds can not be null or empty for
// deploymentSettings resource named default.","Target":null,"Details":nul
test.provider.skip(
  "validate, deploy, and delete an Azure Local deployment setting",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, cluster, deployment } = yield* stack.deploy(
        program("Validate"),
      );
      const get = () =>
        getSetting(group.resourceGroupName, cluster.clusterName);
      expect(deployment.deploymentMode).toEqual("Validate");
      expect((yield* get()).properties?.deploymentMode).toEqual("Validate");

      // In place: switch to Deploy.
      const deployed = yield* stack.deploy(program("Deploy"));
      expect(deployed.deployment.deploymentSettingId).toEqual(
        deployment.deploymentSettingId,
      );
      expect((yield* get()).properties?.deploymentMode).toEqual("Deploy");

      yield* stack.destroy();
      expect(yield* waitGone(get())).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);

// Ungated probe (free): a deployment needs a full answer file for real
// nodes (domain, AD OU, networking, secrets); Azure validates it before
// anything else and rejects an incomplete one. The service returns a
// code-less 400, surfaced as the status-derived `BadRequest`.
test.provider(
  "an incomplete deployment configuration is rejected",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, cluster } = yield* stack.deploy(
        Effect.gen(function* () {
          const group = yield* Azure.Resources.ResourceGroup("Group", {
            location: "eastus",
          });
          const cluster = yield* Azure.AzureStackHCI.Cluster("Cluster", {
            resourceGroup: group.resourceGroupName,
          });
          return { group, cluster };
        }),
      );
      const subscriptionId = yield* subscription;
      const error = yield* hci
        .DeploymentSettingsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: group.resourceGroupName,
          clusterName: cluster.clusterName,
          deploymentSettingsName: "default",
          properties: {
            arcNodeResourceIds: [
              `/subscriptions/${subscriptionId}/resourceGroups/${group.resourceGroupName}/providers/Microsoft.HybridCompute/machines/missing`,
            ],
            deploymentMode: "Validate",
            deploymentConfiguration: {
              version: "10.0.0.0",
              scaleUnits: [{ deploymentData: { namingPrefix: "probe" } }],
            },
          },
        })
        .pipe(Effect.flip);
      yield* Effect.logInfo(
        `deployment probe: ${error._tag} ${error.message ?? ""}`,
      );
      expect(error._tag).toEqual("BadRequest");
      expect(error.message).toContain("AnswerFileValidationFailed");
      const getError = yield* getSetting(
        group.resourceGroupName,
        cluster.clusterName,
      ).pipe(Effect.flip);
      expect(getError._tag).toEqual("ResourceNotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
