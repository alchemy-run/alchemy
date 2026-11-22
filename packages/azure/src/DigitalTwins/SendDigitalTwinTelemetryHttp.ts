import * as dt from "@distilled.cloud/azure/digitaltwins-data";
import * as Layer from "effect/Layer";
import { DigitalTwinsRole, makeDigitalTwinsHttpBinding } from "./BindingHttp.ts";
import { SendDigitalTwinTelemetry } from "./SendDigitalTwinTelemetry.ts";

/**
 * Implementation of {@link SendDigitalTwinTelemetry} over the distilled `digitaltwins-data`
 * data plane. Assigns the custom `AzureDigitalTwinsTwinTelemetryRole` on the
 * instance.
 *
 * @layer
 * @provides Azure.DigitalTwins.SendDigitalTwinTelemetry
 */
export const SendDigitalTwinTelemetryHttp = Layer.effect(
  SendDigitalTwinTelemetry,
  makeDigitalTwinsHttpBinding({
    tag: "Azure.DigitalTwins.SendDigitalTwinTelemetry",
    operation: dt.SendDigitalTwinTelemetry,
    grant: DigitalTwinsRole.TwinTelemetry,
  }),
);
