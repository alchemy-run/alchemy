import * as cosmos from "@distilled.cloud/azure/cosmos-nosql";
import * as Layer from "effect/Layer";
import { ContainerRoles, makeDocumentBinding } from "./BindingHttp.ts";
import { UpsertDocument } from "./UpsertDocument.ts";

/**
 * Implementation of {@link UpsertDocument} over the distilled `cosmos-nosql` data
 * plane. Assigns a custom role with `readMetadata` and `items/upsert` on the container.
 *
 * @layer
 * @provides Azure.CosmosDB.UpsertDocument
 */
export const UpsertDocumentHttp = Layer.effect(
  UpsertDocument,
  makeDocumentBinding({
    tag: "Azure.CosmosDB.UpsertDocument",
    role: ContainerRoles.UpsertDocument,
    operation: cosmos.UpsertDocument,
  }),
);
