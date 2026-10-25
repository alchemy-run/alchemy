import * as cosmos from "@distilled.cloud/azure/cosmos-nosql";
import * as Layer from "effect/Layer";
import { ContainerRoles, makeDocumentBinding } from "./BindingHttp.ts";
import { QueryDocuments } from "./QueryDocuments.ts";

/**
 * Implementation of {@link QueryDocuments} over the distilled `cosmos-nosql` data
 * plane. Assigns a custom role with `readMetadata`, `executeQuery`, and `readChangeFeed` on the container.
 *
 * @layer
 * @provides Azure.CosmosDB.QueryDocuments
 */
export const QueryDocumentsHttp = Layer.effect(
  QueryDocuments,
  makeDocumentBinding({
    tag: "Azure.CosmosDB.QueryDocuments",
    role: ContainerRoles.QueryDocuments,
    operation: cosmos.QueryDocuments,
  }),
);
