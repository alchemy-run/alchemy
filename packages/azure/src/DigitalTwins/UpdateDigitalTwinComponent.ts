import type * as dt from "@distilled.cloud/azure/digitaltwins-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface UpdateDigitalTwinComponentRequest extends Omit<
  dt.UpdateDigitalTwinComponentRequest,
  "endpoint"
> {}

/**
 * Update one component of a digital twin with a JSON Patch document.
 *
 * Binding assigns a custom role (`AzureDigitalTwinsTwinWriteRole`, one per
 * stack) with exactly the data action `Microsoft.DigitalTwins/digitaltwins/write`, on
 * the bound instance only (the built-in Azure Digital Twins Data Reader /
 * Data Owner roles grant every read / every action).
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link UpdateDigitalTwinComponentHttp}.
 *
 * ### Calling UpdateDigitalTwinComponent
 * **Example:** UpdateDigitalTwinComponent from a Function
 * ```typescript
 * // init
 * const twins = yield* Azure.DigitalTwins.Instance("factory");
 * const updateDigitalTwinComponent = yield* Azure.DigitalTwins.UpdateDigitalTwinComponent(twins);
 *
 * // runtime
 * yield* updateDigitalTwinComponent({
 *   id: "room-1",
 *   componentPath: "thermostat",
 *   body: [{ op: "replace", path: "/setpoint", value: 20 }],
 * });
 *
 * // layer
 * Effect.provide(Azure.DigitalTwins.UpdateDigitalTwinComponentHttp)
 * ```
 *
 * @binding
 * @category DigitalTwins
 */
export interface UpdateDigitalTwinComponent extends Binding.Service<
  UpdateDigitalTwinComponent,
  "Azure.DigitalTwins.UpdateDigitalTwinComponent",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: UpdateDigitalTwinComponentRequest,
    ) => Effect.Effect<
      dt.UpdateDigitalTwinComponentResponse,
      dt.UpdateDigitalTwinComponentError,
      RuntimeContext
    >
  >
> {}

export const UpdateDigitalTwinComponent = Binding.Service<UpdateDigitalTwinComponent>(
  "Azure.DigitalTwins.UpdateDigitalTwinComponent",
);
