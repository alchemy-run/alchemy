import * as Layer from "effect/Layer";
import { ContainerRoles, makeSqlContainerBinding } from "./BindingHttp.ts";
import { SqlContainerWrite } from "./SqlContainerWrite.ts";

/**
 * Implementation of {@link SqlContainerWrite} over the distilled
 * `cosmos-nosql` data plane. Assigns a custom role with `readMetadata`,
 * `items/create`, `items/upsert`, `items/replace`, and `items/delete` on the
 * container.
 *
 * @layer
 * @provides Azure.CosmosDB.SqlContainerWrite
 */
export const SqlContainerWriteHttp = Layer.effect(
  SqlContainerWrite,
  makeSqlContainerBinding({
    tag: "Azure.CosmosDB.SqlContainerWrite",
    role: ContainerRoles.SqlContainerWrite,
    makeClient: (documents) => ({
      create: documents.create,
      upsert: documents.upsert,
      replace: documents.replace,
      patch: documents.patch,
      delete: documents.delete,
    }),
  }),
);
