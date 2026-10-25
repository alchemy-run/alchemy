import * as cosmos from "@distilled.cloud/azure/cosmos-nosql";
import * as Layer from "effect/Layer";
import { ContainerRoles, makeDocumentBinding } from "./BindingHttp.ts";
import { CreateDocument } from "./CreateDocument.ts";

/**
 * Implementation of {@link CreateDocument} over the distilled `cosmos-nosql` data
 * plane. Assigns a custom role with `readMetadata` and `items/create` on the container.
 *
 * @layer
 * @provides Azure.CosmosDB.CreateDocument
 */
export const CreateDocumentHttp = Layer.effect(
  CreateDocument,
  makeDocumentBinding({
    tag: "Azure.CosmosDB.CreateDocument",
    role: ContainerRoles.CreateDocument,
    operation: cosmos.CreateDocument,
  }),
);
