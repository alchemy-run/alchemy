import type * as dt from "@distilled.cloud/azure/digitaltwins-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface SendDigitalTwinComponentTelemetryRequest extends Omit<
  dt.SendDigitalTwinComponentTelemetryRequest,
  "endpoint"
> {}

/**
 * Send telemetry on behalf of one component of a digital twin.
 *
 * Binding assigns a custom role (`AzureDigitalTwinsTwinTelemetryRole`, one per
 * stack) with the data action `Microsoft.DigitalTwins/digitaltwins/*`, on the
 * bound instance only. Sending telemetry checks a twin action Microsoft does
 * not publish (none of the listed `digitaltwins/*` actions, including
 * `commands/action`, is enough), so a custom role can only grant it through
 * that wildcard; it is still narrower than the built-in Azure Digital Twins
 * Data Owner role.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link SendDigitalTwinComponentTelemetryHttp}.
 *
 * ### Calling SendDigitalTwinComponentTelemetry
 * **Example:** SendDigitalTwinComponentTelemetry from a Function
 * ```typescript
 * // init
 * const twins = yield* Azure.DigitalTwins.Instance("factory");
 * const sendDigitalTwinComponentTelemetry = yield* Azure.DigitalTwins.SendDigitalTwinComponentTelemetry(twins);
 *
 * // runtime
 * yield* sendDigitalTwinComponentTelemetry({
 *   id: "room-1",
 *   componentPath: "thermostat",
 *   messageId: "m-2",
 *   body: { setpoint: 20 },
 * });
 *
 * // layer
 * Effect.provide(Azure.DigitalTwins.SendDigitalTwinComponentTelemetryHttp)
 * ```
 *
 * @binding
 * @category DigitalTwins
 */
export interface SendDigitalTwinComponentTelemetry extends Binding.Service<
  SendDigitalTwinComponentTelemetry,
  "Azure.DigitalTwins.SendDigitalTwinComponentTelemetry",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: SendDigitalTwinComponentTelemetryRequest,
    ) => Effect.Effect<
      dt.SendDigitalTwinComponentTelemetryResponse,
      dt.SendDigitalTwinComponentTelemetryError,
      RuntimeContext
    >
  >
> {}

export const SendDigitalTwinComponentTelemetry = Binding.Service<SendDigitalTwinComponentTelemetry>(
  "Azure.DigitalTwins.SendDigitalTwinComponentTelemetry",
);
