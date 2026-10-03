import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as asr from "@distilled.cloud/azure/recoveryservicessiterecovery";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { fabricsStack, logLevel, subscription, tags } from "./shared.ts";

const { test } = Test.make({ providers: Azure.providers() });

const program = (props: {
  sendToOwners: "Send" | "DoNotSend";
  customEmailAddresses: string[];
  locale: string;
}) =>
  Effect.gen(function* () {
    // Site Recovery only accepts alert settings once a fabric is registered.
    const { group, vault } = yield* fabricsStack;
    const alerts = yield* Azure.SiteRecovery.AlertSetting("Alerts", {
      resourceGroup: group.resourceGroupName,
      vault: vault.vaultName,
      ...props,
    });
    return { group, vault, alerts };
  });

const getAlerts = (rg: string, vault: string) =>
  Effect.gen(function* () {
    return yield* asr.GetReplicationAlertSettings({
      subscriptionId: yield* subscription,
      resourceGroupName: rg,
      resourceName: vault,
      alertSettingName: "defaultAlertSetting",
    });
  });

// Vault, A2A fabrics, and alert settings are free; ~6 minutes.
test.provider(
  "configure, update, and reset site recovery alert settings",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Create (configure the vault singleton).
      const created = yield* stack.deploy(
        program({
          sendToOwners: "Send",
          customEmailAddresses: ["dr-alerts@example.com"],
          locale: "en-US",
        }),
      );
      const rg = created.group.resourceGroupName;
      const vault = created.vault.vaultName;
      expect(created.alerts.alertSettingName).toEqual("defaultAlertSetting");
      const observed = yield* getAlerts(rg, vault);
      expect(observed.properties?.sendToOwners).toEqual("Send");
      expect(observed.properties?.customEmailAddresses).toEqual([
        "dr-alerts@example.com",
      ]);
      expect(observed.properties?.locale).toEqual("en-US");

      // In-place update.
      const updated = yield* stack.deploy(
        program({
          sendToOwners: "DoNotSend",
          customEmailAddresses: ["a@example.com", "b@example.com"],
          locale: "fr-FR",
        }),
      );
      expect(updated.alerts.alertSettingId).toEqual(
        created.alerts.alertSettingId,
      );
      const reobserved = yield* getAlerts(rg, vault);
      expect(reobserved.properties?.sendToOwners).toEqual("DoNotSend");
      expect(
        [...(reobserved.properties?.customEmailAddresses ?? [])].sort(),
      ).toEqual(["a@example.com", "b@example.com"]);
      expect(reobserved.properties?.locale).toEqual("fr-FR");

      // Delete: no delete API, the setting is reset to the vault default.
      yield* stack.deploy(fabricsStack);
      const reset = yield* getAlerts(rg, vault);
      expect(reset.properties?.sendToOwners).toEqual("DoNotSend");
      expect(reset.properties?.customEmailAddresses ?? []).toEqual([]);

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
