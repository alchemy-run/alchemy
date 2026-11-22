import type * as Effect from "effect/Effect";
import { type ArmActionRole, groupOf, makeArmActionBinding } from "../ArmActionBinding.ts";
import type { IotHub } from "./IotHub.ts";

/**
 * Shared scaffolding for the IoT Hub runtime-action bindings: the bound
 * hub supplies `subscriptionId`, `resourceGroupName` and `resourceName`,
 * and each binding assigns its custom role on the hub only.
 *
 * NOT exported from `index.ts`.
 */

/** IoT Hub permissions the bindings grant (Azure RBAC actions). */
export const IoTHubPermission = {
  exportDevices: "Microsoft.Devices/iotHubs/exportDevices/Action",
  importDevices: "Microsoft.Devices/iotHubs/importDevices/Action",
} as const;

/**
 * Custom role per binding; the logical ID is `Azure<role>Role`. Built-in
 * roles with these actions (e.g. **Contributor**) also edit the hub.
 */
export const IoTHubRole = {
  ExportDevices: { role: "IoTHubExportDevices", actions: [IoTHubPermission.exportDevices] },
  ImportDevices: { role: "IoTHubImportDevices", actions: [IoTHubPermission.importDevices] },
} as const satisfies Record<string, ArmActionRole>;

/**
 * Build the impl Effect for a hub action: the runtime callable fills the
 * hub's identifiers, and the deploy-time half assigns `role` on the hub.
 */
export const makeIotHubActionBinding = <
  I extends { subscriptionId: string; resourceGroupName: string; resourceName: string },
  A,
  E,
>(options: {
  /** Fully-qualified binding tag, e.g. `Azure.IoTHub.ExportDevices`. */
  tag: string;
  /** The distilled `iothub` operation. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, any>;
  /** The custom role assigned on the hub. */
  role: ArmActionRole;
}) =>
  makeArmActionBinding({
    ...options,
    scope: (hub: IotHub) => hub.iotHubId,
    target: (hub) => hub.iotHubId,
    input: (request: Omit<I, "subscriptionId" | "resourceGroupName" | "resourceName">, id) =>
      ({ ...request, ...groupOf(id), resourceName: id.names.iothubs ?? "" }) as I,
  });
