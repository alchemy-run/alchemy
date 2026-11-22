import * as cosmos from "@distilled.cloud/azure/cosmos-nosql";
import * as Layer from "effect/Layer";
import { ContainerRoles, makeDocumentBinding } from "./BindingHttp.ts";
import { DeleteDocument } from "./DeleteDocument.ts";

/**
 * Implementation of {@link DeleteDocument} over the distilled `cosmos-nosql` data
 * plane. Assigns a custom role with `readMetadata` and `items/delete` on the container.
 *
 * @layer
 * @provides Azure.CosmosDB.DeleteDocument
 */
export const DeleteDocumentHttp = Layer.effect(
  DeleteDocument,
  makeDocumentBinding({
    tag: "Azure.CosmosDB.DeleteDocument",
    role: ContainerRoles.DeleteDocument,
    operation: cosmos.DeleteDocument,
  }),
);
