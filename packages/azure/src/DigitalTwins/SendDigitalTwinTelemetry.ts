import type * as dt from "@distilled.cloud/azure/digitaltwins-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface SendDigitalTwinTelemetryRequest extends Omit<
  dt.SendDigitalTwinTelemetryRequest,
  "endpoint"
> {}

/**
 * Send telemetry on behalf of a digital twin; event routes deliver it to their endpoints.
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
 * Provide {@link SendDigitalTwinTelemetryHttp}.
 *
 * ### Calling SendDigitalTwinTelemetry
 * **Example:** SendDigitalTwinTelemetry from a Function
 * ```typescript
 * // init
 * const twins = yield* Azure.DigitalTwins.Instance("factory");
 * const sendDigitalTwinTelemetry = yield* Azure.DigitalTwins.SendDigitalTwinTelemetry(twins);
 *
 * // runtime
 * yield* sendDigitalTwinTelemetry({ id: "room-1", messageId: "m-1", body: { temperature: 21.5 } });
 *
 * // layer
 * Effect.provide(Azure.DigitalTwins.SendDigitalTwinTelemetryHttp)
 * ```
 *
 * @binding
 * @category DigitalTwins
 */
export interface SendDigitalTwinTelemetry extends Binding.Service<
  SendDigitalTwinTelemetry,
  "Azure.DigitalTwins.SendDigitalTwinTelemetry",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: SendDigitalTwinTelemetryRequest,
    ) => Effect.Effect<
      dt.SendDigitalTwinTelemetryResponse,
      dt.SendDigitalTwinTelemetryError,
      RuntimeContext
    >
  >
> {}

export const SendDigitalTwinTelemetry = Binding.Service<SendDigitalTwinTelemetry>(
  "Azure.DigitalTwins.SendDigitalTwinTelemetry",
);
