import * as deid from "@distilled.cloud/azure/healthdataaiservices-data";
import * as Layer from "effect/Layer";
import { DeidRole, makeDeidHttpBinding } from "./BindingHttp.ts";
import { ListJobDocuments } from "./ListJobDocuments.ts";

/**
 * Implementation of {@link ListJobDocuments} over the distilled
 * `healthdataaiservices-data` data plane. Assigns **DeID Batch Data Reader** on
 * the service.
 *
 * @layer
 * @provides Azure.HealthDataAIServices.ListJobDocuments
 */
export const ListJobDocumentsHttp = Layer.effect(
  ListJobDocuments,
  makeDeidHttpBinding({
    tag: "Azure.HealthDataAIServices.ListJobDocuments",
    operation: deid.ListJobDocuments,
    grant: DeidRole.BatchReader,
  }),
);
