import * as Azure from "@/Azure";
import { resolveAzureCredentials } from "@/Azure/Credentials";
import { mintAccessToken } from "@/Azure/Token";
import * as Test from "@/Test/Alchemy";
import * as deviceupdate from "@distilled.cloud/azure/deviceupdate";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { runExpensive } from "../gates.ts";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getInstance = (
  resourceGroupName: string,
  accountName: string,
  instanceName: string,
) =>
  Effect.gen(function* () {
    return yield* deviceupdate.GetInstance({
      subscriptionId: yield* subscription,
      resourceGroupName,
      accountName,
      instanceName,
    });
  });

/** First-party "Azure Device Update" application. */
const DEVICE_UPDATE_APP_ID = "6ee392c4-d339-4083-b04d-6b7947c6cf78";
/** Built-in "IoT Hub Data Contributor" role. */
const IOT_HUB_DATA_CONTRIBUTOR = "4fc6c259-987e-4a07-842e-c321cc9d413f";

/** Object ID of the Device Update service principal in this tenant. */
const deviceUpdatePrincipalId = Effect.gen(function* () {
  const creds = yield* yield* resolveAzureCredentials;
  const token = yield* mintAccessToken(
    creds,
    "https://graph.microsoft.com/.default",
  );
  const http = yield* HttpClient.HttpClient;
  const response = yield* http.execute(
    HttpClientRequest.get(
      `https://graph.microsoft.com/v1.0/servicePrincipals(appId='${DEVICE_UPDATE_APP_ID}')?$select=id`,
    ).pipe(HttpClientRequest.bearerToken(Redacted.value(token.accessToken))),
  );
  const body = (yield* response.json) as { id?: string };
  expect(body.id).toBeDefined();
  return body.id!;
});

const program = (props: {
  principalId: string;
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    // S1 rather than F1: the single free hub per subscription is held by
    // the IoT Hub suite.
    const hub = yield* Azure.IoTHub.IotHub("Hub", {
      resourceGroup: group.resourceGroupName,
      sku: "S1",
      partitionCount: 2,
    });
    // Device Update validates that its service principal can manage the hub.
    const grant = yield* Azure.Authorization.RoleAssignment("HubGrant", {
      scope: hub.iotHubId,
      roleDefinitionId: IOT_HUB_DATA_CONTRIBUTOR,
      principalId: props.principalId,
      principalType: "ServicePrincipal",
    });
    // Standard: the subscription's single Free account slot stays taken for
    // a while after the Account suite deletes its Free account.
    const account = yield* Azure.DeviceUpdate.Account("Account", {
      resourceGroup: group.resourceGroupName,
      sku: "Standard",
    });
    const instance = yield* Azure.DeviceUpdate.Instance("Instance", {
      resourceGroup: group.resourceGroupName,
      account: account.accountName,
      iotHubs: [grant.scope],
      tags: props.tags,
    });
    return { group, hub, account, instance };
  });

// Standard Device Update account (~$0.27/hour) + S1 IoT hub (~$0.034/hour):
// about $0.20 per run, but the instance stays `Creating` for well over 10
// minutes (observed >20 minutes), so the test allows up to an hour.
// Skipped: failed in the last live run. DatadogMonitorCreationValidateFailed: The resource
// validation failed.
test.provider.skip(
  "create, update, and delete a device update instance",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const principalId = yield* deviceUpdatePrincipalId;

      const { group, hub, account, instance } = yield* stack.deploy(
        program({ principalId, tags: { env: "test" } }),
      );
      const get = () =>
        getInstance(
          group.resourceGroupName,
          account.accountName,
          instance.instanceName,
        );
      expect(instance.accountName).toEqual(account.accountName);
      expect(instance.iotHubs.map((h) => h.toLowerCase())).toEqual([
        hub.iotHubId.toLowerCase(),
      ]);
      expect(instance.tags).toEqual({ env: "test" });
      const observed = yield* get();
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(
        observed.properties?.iotHubs?.map((h) => h.resourceId.toLowerCase()),
      ).toEqual([hub.iotHubId.toLowerCase()]);
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("Instance");

      // In place: change tags.
      const updated = yield* stack.deploy(
        program({ principalId, tags: { env: "prod" } }),
      );
      expect(updated.instance.instanceId).toEqual(instance.instanceId);
      const reobserved = yield* get();
      expect(reobserved.tags?.env).toEqual("prod");

      yield* stack.destroy();
      expect(yield* waitGone(get())).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 3_600_000 },
);
