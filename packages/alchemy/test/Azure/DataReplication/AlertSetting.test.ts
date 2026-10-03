import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as dr from "@distilled.cloud/azure/recoveryservicesdatareplication";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { runPaidOnly } from "../gates.ts";
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

// Alert settings are free, but Microsoft.DataReplication refuses every
// alertSettings PUT on a fresh vault (DisasterRecovery and Migrate vault
// types, api-versions 2024-09-01 and 2026-05-01, names "default" and "0",
// retried for ~2 minutes) with `ResourceNotFound: Resource 'default' does
// not exist.` — the setting appears to need a vault already onboarded to an
// Azure Migrate project. The probe below pins that rejection; run the
// lifecycle (~3 minutes) with AZURE_TEST_PAID=1 on an onboarded subscription.
test.provider(
  "probe: alert settings PUT on a fresh vault is rejected",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { group, vault } = yield* stack.deploy(vaultStack);
      const result = yield* Effect.result(
        dr.CreateEmailConfiguration({
          subscriptionId: yield* subscription,
          resourceGroupName: group.resourceGroupName,
          vaultName: vault.vaultName,
          emailConfigurationName: "default",
          properties: {
            sendToOwners: true,
            customEmailAddresses: ["dr-alerts@example.com"],
            locale: "en-US",
          },
        }),
      );
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure._tag).toEqual("ResourceNotFound");
        expect(result.failure.message).toEqual(
          "Resource 'default' does not exist.",
        );
      }
      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);

test.provider.skipIf(!runPaidOnly)(
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
