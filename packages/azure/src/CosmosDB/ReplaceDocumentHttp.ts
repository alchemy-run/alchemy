import * as cosmos from "@distilled.cloud/azure/cosmos-nosql";
import * as Layer from "effect/Layer";
import { ContainerRoles, makeDocumentBinding } from "./BindingHttp.ts";
import { ReplaceDocument } from "./ReplaceDocument.ts";

/**
 * Implementation of {@link ReplaceDocument} over the distilled `cosmos-nosql` data
 * plane. Assigns a custom role with `readMetadata` and `items/replace` on the container.
 *
 * @layer
 * @provides Azure.CosmosDB.ReplaceDocument
 */
export const ReplaceDocumentHttp = Layer.effect(
  ReplaceDocument,
  makeDocumentBinding({
    tag: "Azure.CosmosDB.ReplaceDocument",
    role: ContainerRoles.ReplaceDocument,
    operation: cosmos.ReplaceDocument,
  }),
);
