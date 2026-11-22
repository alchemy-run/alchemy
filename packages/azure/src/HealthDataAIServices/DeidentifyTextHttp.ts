import * as deid from "@distilled.cloud/azure/healthdataaiservices-data";
import * as Layer from "effect/Layer";
import { DeidRole, makeDeidHttpBinding } from "./BindingHttp.ts";
import { DeidentifyText } from "./DeidentifyText.ts";

/**
 * Implementation of {@link DeidentifyText} over the distilled
 * `healthdataaiservices-data` data plane. Assigns **DeID Realtime Data User**
 * on the service.
 *
 * @layer
 * @provides Azure.HealthDataAIServices.DeidentifyText
 */
export const DeidentifyTextHttp = Layer.effect(
  DeidentifyText,
  makeDeidHttpBinding({
    tag: "Azure.HealthDataAIServices.DeidentifyText",
    operation: deid.DeidentifyText,
    grant: DeidRole.RealtimeUser,
  }),
);
