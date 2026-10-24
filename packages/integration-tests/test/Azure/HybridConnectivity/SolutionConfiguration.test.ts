import * as Azure from "@alchemy.run/azure";
import * as hybridconnectivity from "@distilled.cloud/azure/hybridconnectivity";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import { fixtureAwsAccountA, fixtureAwsAccountB, logLevel, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getConfiguration = (resourceUri: string, solutionConfiguration: string) =>
  hybridconnectivity.GetSolutionConfiguration({ resourceUri, solutionConfiguration });

const program = (props: { scope: "A" | "B"; services: string }) =>
  Effect.gen(function* () {
    // Both connectors stay deployed across the replacement step.
    const group = yield* Azure.Resources.ResourceGroup("Group", { location: "eastus" });
    const connectorA = yield* Azure.HybridConnectivity.PublicCloudConnector("AwsA", {
      resourceGroup: group.resourceGroupName,
      location: "eastus",
      hostType: "AWS",
      awsCloudProfile: { accountId: fixtureAwsAccountA },
    });
    const connectorB = yield* Azure.HybridConnectivity.PublicCloudConnector("AwsB", {
      resourceGroup: group.resourceGroupName,
      location: "eastus",
      hostType: "AWS",
      awsCloudProfile: { accountId: fixtureAwsAccountB },
    });
    const connector = props.scope === "A" ? connectorA : connectorB;
    const inventory = yield* Azure.HybridConnectivity.SolutionConfiguration("Inventory", {
      resourceUri: connector.publicCloudConnectorId,
      solutionType: "Microsoft.AssetManagement",
      solutionSettings: {
        cloudProviderServiceTypes: props.services,
        periodicSync: "true",
        periodicSyncTime: "1",
      },
    });
    return { connectorA, connectorB, inventory };
  });

// Free control-plane resources on connectors to fake AWS accounts (the
// solution reports AuthorizationFailed, which the lifecycle tolerates).
// About a minute.
test.provider(
  "create, update, replace, and delete a solution configuration",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { connectorA, connectorB, inventory } = yield* stack.deploy(
        program({ scope: "A", services: "ec2,s3" }),
      );
      const uriA = connectorA.publicCloudConnectorId;
      const uriB = connectorB.publicCloudConnectorId;
      expect(inventory.solutionConfigurationName).toMatch(/^[a-zA-Z0-9-]{3,63}$/);
      expect(inventory.solutionType).toEqual("Microsoft.AssetManagement");
      expect(inventory.solutionSettings.cloudProviderServiceTypes).toEqual("ec2,s3");
      const observed = yield* getConfiguration(uriA, inventory.solutionConfigurationName);
      expect(observed.properties?.solutionSettings?.periodicSync).toEqual("true");
      expect(observed.properties?.solutionSettings?.cloudProviderServiceTypes).toEqual("ec2,s3");

      // In place: change a setting (upserting PUT).
      const updated = yield* stack.deploy(program({ scope: "A", services: "ec2" }));
      expect(updated.inventory.solutionConfigurationId).toEqual(inventory.solutionConfigurationId);
      const reobserved = yield* getConfiguration(uriA, inventory.solutionConfigurationName);
      expect(reobserved.properties?.solutionSettings?.cloudProviderServiceTypes).toEqual("ec2");

      // Replacement: move to the other connector.
      const replaced = yield* stack.deploy(program({ scope: "B", services: "ec2" }));
      expect(replaced.inventory.resourceUri).toEqual(uriB);
      const moved = yield* getConfiguration(uriB, replaced.inventory.solutionConfigurationName);
      expect(moved.properties?.solutionType).toEqual("Microsoft.AssetManagement");
      const oldGone = yield* waitGone(getConfiguration(uriA, inventory.solutionConfigurationName));
      expect(oldGone).toEqual("gone");

      yield* stack.destroy();
      const newGone = yield* waitGone(
        getConfiguration(uriB, replaced.inventory.solutionConfigurationName),
      );
      expect(newGone).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
