import * as Layer from "effect/Layer";
import { ContainerRoles, makeSqlContainerBinding } from "./BindingHttp.ts";
import { SqlContainerReadWrite } from "./SqlContainerReadWrite.ts";

/**
 * Implementation of {@link SqlContainerReadWrite} over the distilled
 * `cosmos-nosql` data plane. Assigns a custom role with the read, query,
 * change-feed, and item write actions on the container.
 *
 * @layer
 * @provides Azure.CosmosDB.SqlContainerReadWrite
 */
export const SqlContainerReadWriteHttp = Layer.effect(
  SqlContainerReadWrite,
  makeSqlContainerBinding({
    tag: "Azure.CosmosDB.SqlContainerReadWrite",
    role: ContainerRoles.SqlContainerReadWrite,
    makeClient: (documents) => documents,
  }),
);
