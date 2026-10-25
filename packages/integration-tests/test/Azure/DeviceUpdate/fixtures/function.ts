import * as Azure from "@alchemy.run/azure";
import * as servicePrincipals from "@distilled.cloud/microsoft-graph/servicePrincipals";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import { distilledFromSource } from "../../Functions/fixtures/distilled-source.ts";

/** Built-in "IoT Hub Data Contributor" role. */
const IOT_HUB_DATA_CONTRIBUTOR = "4fc6c259-987e-4a07-842e-c321cc9d413f";

/** First-party "Azure Device Update" application. */
const DEVICE_UPDATE_APP_ID = "6ee392c4-d339-4083-b04d-6b7947c6cf78";

/**
 * Object ID of the Device Update service principal (deploy time only), read
 * with the deployer's Graph credentials: a Function's init may only require
 * its ARM credentials, and may only fail with `ConfigError`.
 */
const deviceUpdatePrincipalId = globalThis.__ALCHEMY_RUNTIME__
  ? Effect.succeed("")
  : servicePrincipals
      .getServicePrincipalByAppId({ appId: DEVICE_UPDATE_APP_ID, select: ["id"] })
      .pipe(
        Effect.map((principal) => principal.id ?? ""),
        Effect.provide(Azure.graphFromAuthProvider()),
        Effect.orDie,
      );

// S1 rather than F1: the single free hub per subscription is held by the
// IoT Hub suite.
export const Hub = Azure.IoTHub.IotHub("DuBindingsHub", { sku: "S1", partitionCount: 2 });

export const Account = Azure.DeviceUpdate.Account("DuBindingsAccount", { sku: "Standard" });

export const Fleet = Effect.gen(function* () {
  const hub = yield* Hub;
  const account = yield* Account;
  const principalId = yield* deviceUpdatePrincipalId;
  // Device Update validates that its service principal can manage the hub.
  const grant = yield* Azure.Authorization.RoleAssignment("DuBindingsHubGrant", {
    scope: hub.iotHubId,
    roleDefinitionId: IOT_HUB_DATA_CONTRIBUTOR,
    principalId,
    principalType: "ServicePrincipal",
  });
  return yield* Azure.DeviceUpdate.Instance("DuBindingsFleet", {
    account: account.accountName,
    iotHubs: [grant.scope],
  });
});

/** Answer `{ ok, result }`, or `{ ok: false, error }` with a 500 so callers retry. */
const respond = (effect: Effect.Effect<unknown, unknown, RuntimeContext>) =>
  effect.pipe(
    Effect.flatMap((result) => HttpServerResponse.json({ ok: true, result })),
    Effect.catchCause((cause) =>
      HttpServerResponse.json({ ok: false, error: Cause.pretty(cause) }, { status: 500 }),
    ),
  );

/**
 * Effect-native Azure Function exercising the Device Update read bindings
 * an empty instance can answer, one route per binding.
 */
export default class DuFunction extends Azure.Functions.Function<DuFunction>()(
  "DuBindingsFunction",
  {
    main: import.meta.url,
    // TEMPORARY: this checkout's distilled `lib/` is stale (see distilled-source.ts).
    build: { input: { plugins: [distilledFromSource] } },
  },
  Effect.gen(function* () {
    const fleet = yield* Fleet;
    const listUpdates = yield* Azure.DeviceUpdate.ListUpdates(fleet);
    const listProviders = yield* Azure.DeviceUpdate.ListUpdateProviders(fleet);
    const listGroups = yield* Azure.DeviceUpdate.ListGroups(fleet);
    const listDevices = yield* Azure.DeviceUpdate.ListDevices(fleet);
    const listDeviceClasses = yield* Azure.DeviceUpdate.ListDeviceClasses(fleet);
    const getCompliance = yield* Azure.DeviceUpdate.GetUpdateCompliance(fleet);
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://localhost");
        switch (url.pathname) {
          case "/updates":
            return yield* respond(Effect.map(listUpdates(), (page) => page.value.length));
          case "/providers":
            return yield* respond(Effect.map(listProviders(), (page) => page.value.length));
          case "/groups":
            return yield* respond(Effect.map(listGroups(), (page) => page.value.length));
          case "/devices":
            return yield* respond(Effect.map(listDevices(), (page) => page.value.length));
          case "/device-classes":
            return yield* respond(Effect.map(listDeviceClasses(), (page) => page.value.length));
          case "/compliance":
            return yield* respond(Effect.map(getCompliance(), (c) => c.totalDeviceCount));
          default:
            return HttpServerResponse.text("not found", { status: 404 });
        }
      }),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Azure.DeviceUpdate.ListUpdatesHttp,
        Azure.DeviceUpdate.ListUpdateProvidersHttp,
        Azure.DeviceUpdate.ListGroupsHttp,
        Azure.DeviceUpdate.ListDevicesHttp,
        Azure.DeviceUpdate.ListDeviceClassesHttp,
        Azure.DeviceUpdate.GetUpdateComplianceHttp,
      ),
    ),
  ),
) {}
