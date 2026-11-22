import * as cosmos from "@distilled.cloud/azure/cosmos-nosql";
import * as Layer from "effect/Layer";
import { ContainerRoles, makeDocumentBinding } from "./BindingHttp.ts";
import { ListDocuments } from "./ListDocuments.ts";

/**
 * Implementation of {@link ListDocuments} over the distilled `cosmos-nosql` data
 * plane. Assigns a custom role with `readMetadata` and `readChangeFeed` on the container.
 *
 * @layer
 * @provides Azure.CosmosDB.ListDocuments
 */
export const ListDocumentsHttp = Layer.effect(
  ListDocuments,
  makeDocumentBinding({
    tag: "Azure.CosmosDB.ListDocuments",
    role: ContainerRoles.ListDocuments,
    operation: cosmos.ListDocuments,
  }),
);
