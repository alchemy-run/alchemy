import * as deid from "@distilled.cloud/azure/healthdataaiservices-data";
import * as Layer from "effect/Layer";
import { DeidRole, makeDeidHttpBinding } from "./BindingHttp.ts";
import { DeidentifyDocuments } from "./DeidentifyDocuments.ts";

/**
 * Implementation of {@link DeidentifyDocuments} over the distilled
 * `healthdataaiservices-data` data plane. Assigns the custom
 * `AzureDeidBatchWriteRole` on the service.
 *
 * @layer
 * @provides Azure.HealthDataAIServices.DeidentifyDocuments
 */
export const DeidentifyDocumentsHttp = Layer.effect(
  DeidentifyDocuments,
  makeDeidHttpBinding({
    tag: "Azure.HealthDataAIServices.DeidentifyDocuments",
    operation: deid.DeidentifyDocuments,
    grant: DeidRole.BatchWrite,
  }),
);
