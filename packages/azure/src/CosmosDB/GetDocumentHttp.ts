import * as cosmos from "@distilled.cloud/azure/cosmos-nosql";
import * as Layer from "effect/Layer";
import { ContainerRoles, makeDocumentBinding } from "./BindingHttp.ts";
import { GetDocument } from "./GetDocument.ts";

/**
 * Implementation of {@link GetDocument} over the distilled `cosmos-nosql` data
 * plane. Assigns a custom role with `readMetadata` and `items/read` on the container.
 *
 * @layer
 * @provides Azure.CosmosDB.GetDocument
 */
export const GetDocumentHttp = Layer.effect(
  GetDocument,
  makeDocumentBinding({
    tag: "Azure.CosmosDB.GetDocument",
    role: ContainerRoles.GetDocument,
    operation: cosmos.GetDocument,
  }),
);
