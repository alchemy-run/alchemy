import * as mi from "@distilled.cloud/aws/iot-managed-integrations";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeManagedIntegrationsHttpBinding } from "./BindingHttp.ts";

/**
 * Request for {@link ListDiscoveredDevices}.
 */
export interface ListDiscoveredDevicesRequest extends mi.ListDiscoveredDevicesRequest {}

/**
 * Runtime binding for `iotmanagedintegrations:ListDiscoveredDevices`
 * (account-level).
 *
 * Lists the devices found by a discovery scan, including the managed thing
 * id assigned to each already-onboarded device. Provide the implementation
 * with `Effect.provide(AWS.IoTManagedIntegrations.ListDiscoveredDevicesHttp)`.
 *
 * ### Discovering Devices
 * **Example:** List Devices Found by a Scan
 * ```typescript
 * const listDiscovered = yield* IoTManagedIntegrations.ListDiscoveredDevices();
 *
 * const { Items } = yield* listDiscovered({ Identifier: discoveryId });
 * ```
 *
 * @binding
 */
export interface ListDiscoveredDevices extends Binding.Service<
  ListDiscoveredDevices,
  "AWS.IoTManagedIntegrations.ListDiscoveredDevices",
  () => Effect.Effect<
    (
      request: ListDiscoveredDevicesRequest,
    ) => Effect.Effect<mi.ListDiscoveredDevicesResponse, mi.ListDiscoveredDevicesError>
  >
> {}
export const ListDiscoveredDevices = Binding.Service<ListDiscoveredDevices>(
  "AWS.IoTManagedIntegrations.ListDiscoveredDevices",
);

export const ListDiscoveredDevicesHttp = Layer.effect(
  ListDiscoveredDevices,
  makeManagedIntegrationsHttpBinding({
    capability: "ListDiscoveredDevices",
    iamActions: ["iotmanagedintegrations:ListDiscoveredDevices"],
    operation: mi.listDiscoveredDevices,
  }),
);
