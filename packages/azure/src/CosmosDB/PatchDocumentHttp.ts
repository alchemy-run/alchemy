import * as cosmos from "@distilled.cloud/azure/cosmos-nosql";
import * as Layer from "effect/Layer";
import { ContainerRoles, makeDocumentBinding } from "./BindingHttp.ts";
import { PatchDocument } from "./PatchDocument.ts";

/**
 * Implementation of {@link PatchDocument} over the distilled `cosmos-nosql` data
 * plane. Assigns a custom role with `readMetadata` and `items/replace` (Cosmos DB checks `replace` for a patch) on the container.
 *
 * @layer
 * @provides Azure.CosmosDB.PatchDocument
 */
export const PatchDocumentHttp = Layer.effect(
  PatchDocument,
  makeDocumentBinding({
    tag: "Azure.CosmosDB.PatchDocument",
    role: ContainerRoles.PatchDocument,
    operation: cosmos.PatchDocument,
  }),
);
