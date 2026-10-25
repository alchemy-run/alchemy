import * as dt from "@distilled.cloud/azure/digitaltwins-data";
import * as Layer from "effect/Layer";
import { DigitalTwinsRole, makeDigitalTwinsHttpBinding } from "./BindingHttp.ts";
import { SendDigitalTwinComponentTelemetry } from "./SendDigitalTwinComponentTelemetry.ts";

/**
 * Implementation of {@link SendDigitalTwinComponentTelemetry} over the distilled `digitaltwins-data`
 * data plane. Assigns the custom `AzureDigitalTwinsTwinTelemetryRole` on the
 * instance.
 *
 * @layer
 * @provides Azure.DigitalTwins.SendDigitalTwinComponentTelemetry
 */
export const SendDigitalTwinComponentTelemetryHttp = Layer.effect(
  SendDigitalTwinComponentTelemetry,
  makeDigitalTwinsHttpBinding({
    tag: "Azure.DigitalTwins.SendDigitalTwinComponentTelemetry",
    operation: dt.SendDigitalTwinComponentTelemetry,
    grant: DigitalTwinsRole.TwinTelemetry,
  }),
);
