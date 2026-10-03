import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as hci from "@distilled.cloud/azure/azurestackhci";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getSetting = (resourceGroupName: string, clusterName: string) =>
  Effect.gen(function* () {
    return yield* hci.GetSecuritySettings({
      subscriptionId: yield* subscription,
      resourceGroupName,
      clusterName,
      securitySettingsName: "default",
    });
  });

const program = (props: {
  onSecond: boolean;
  wdac: Azure.AzureStackHCI.ComplianceAssignment;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    // Both clusters stay deployed across the replacement step.
    const first = yield* Azure.AzureStackHCI.Cluster("First", {
      resourceGroup: group.resourceGroupName,
    });
    const second = yield* Azure.AzureStackHCI.Cluster("Second", {
      resourceGroup: group.resourceGroupName,
    });
    const setting = yield* Azure.AzureStackHCI.SecuritySetting("Security", {
      resourceGroup: group.resourceGroupName,
      cluster: props.onSecond ? second.clusterName : first.clusterName,
      wdacComplianceAssignment: props.wdac,
    });
    return { group, first, second, setting };
  });

// Two cluster records without hardware plus their security settings:
// free, seconds to create.
test.provider(
  "create, update, replace, and delete a cluster security setting",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, first, setting } = yield* stack.deploy(
        program({ onSecond: false, wdac: "Audit" }),
      );
      const get = (cluster: string) =>
        getSetting(group.resourceGroupName, cluster);
      expect(setting.clusterName).toEqual(first.clusterName);
      const observed = yield* get(first.clusterName);
      expect(observed.properties?.wdacComplianceAssignment).toEqual("Audit");
      expect(observed.properties?.securedCoreComplianceAssignment).toEqual(
        "Audit",
      );

      // In place: enforce WDAC.
      const updated = yield* stack.deploy(
        program({ onSecond: false, wdac: "ApplyAndAutoCorrect" }),
      );
      expect(updated.setting.securitySettingId).toEqual(
        setting.securitySettingId,
      );
      expect(updated.setting.wdacComplianceAssignment).toEqual(
        "ApplyAndAutoCorrect",
      );
      const reobserved = yield* get(first.clusterName);
      expect(reobserved.properties?.wdacComplianceAssignment).toEqual(
        "ApplyAndAutoCorrect",
      );

      // Replacement: move the setting to the second cluster.
      const replaced = yield* stack.deploy(
        program({ onSecond: true, wdac: "ApplyAndAutoCorrect" }),
      );
      expect(replaced.setting.clusterName).toEqual(replaced.second.clusterName);
      const replacedObserved = yield* get(replaced.second.clusterName);
      expect(replacedObserved.properties?.wdacComplianceAssignment).toEqual(
        "ApplyAndAutoCorrect",
      );
      expect(yield* waitGone(get(first.clusterName))).toEqual("gone");

      yield* stack.destroy();
      expect(yield* waitGone(get(replaced.second.clusterName))).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
