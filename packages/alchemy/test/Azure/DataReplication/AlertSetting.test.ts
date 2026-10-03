import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as dr from "@distilled.cloud/azure/recoveryservicesdatareplication";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, subscription, tags, vaultStack } from "./shared.ts";

const { test } = Test.make({ providers: Azure.providers() });

const program = (props: {
  sendToOwners: boolean;
  customEmailAddresses: string[];
  locale: string;
}) =>
  Effect.gen(function* () {
    const { group, vault } = yield* vaultStack;
    const alerts = yield* Azure.DataReplication.AlertSetting("Alerts", {
      resourceGroup: group.resourceGroupName,
      vault: vault.vaultName,
      ...props,
    });
    return { group, vault, alerts };
  });

const getAlerts = (rg: string, vault: string) =>
  Effect.gen(function* () {
    return yield* dr.GetEmailConfiguration({
      subscriptionId: yield* subscription,
      resourceGroupName: rg,
      vaultName: vault,
      emailConfigurationName: "default",
    });
  });

// Vault and alert settings are free; ~3 minutes.
test.provider(
  "configure, update, and reset data replication alert settings",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        program({
          sendToOwners: true,
          customEmailAddresses: ["dr-alerts@example.com"],
          locale: "en-US",
        }),
      );
      const rg = created.group.resourceGroupName;
      const vault = created.vault.vaultName;
      expect(created.alerts.alertSettingName).toEqual("default");
      const observed = yield* getAlerts(rg, vault);
      expect(observed.properties?.sendToOwners).toEqual(true);
      expect(observed.properties?.customEmailAddresses).toEqual([
        "dr-alerts@example.com",
      ]);
      expect(observed.properties?.locale).toEqual("en-US");

      // In-place update.
      const updated = yield* stack.deploy(
        program({
          sendToOwners: false,
          customEmailAddresses: ["a@example.com", "b@example.com"],
          locale: "fr-FR",
        }),
      );
      expect(updated.alerts.alertSettingId).toEqual(
        created.alerts.alertSettingId,
      );
      const reobserved = yield* getAlerts(rg, vault);
      expect(reobserved.properties?.sendToOwners).toEqual(false);
      expect(
        [...(reobserved.properties?.customEmailAddresses ?? [])].sort(),
      ).toEqual(["a@example.com", "b@example.com"]);
      expect(reobserved.properties?.locale).toEqual("fr-FR");

      // Delete: no delete API, the setting is reset.
      yield* stack.deploy(vaultStack);
      const reset = yield* getAlerts(rg, vault);
      expect(reset.properties?.sendToOwners).toEqual(false);
      expect(reset.properties?.customEmailAddresses ?? []).toEqual([]);

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
