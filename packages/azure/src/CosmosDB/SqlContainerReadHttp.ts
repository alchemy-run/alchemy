import * as Layer from "effect/Layer";
import { ContainerRoles, makeSqlContainerBinding } from "./BindingHttp.ts";
import { SqlContainerRead } from "./SqlContainerRead.ts";

/**
 * Implementation of {@link SqlContainerRead} over the distilled
 * `cosmos-nosql` data plane. Assigns **Cosmos DB Built-in Data Reader** on
 * the container.
 *
 * @layer
 * @provides Azure.CosmosDB.SqlContainerRead
 */
export const SqlContainerReadHttp = Layer.effect(
  SqlContainerRead,
  makeSqlContainerBinding({
    tag: "Azure.CosmosDB.SqlContainerRead",
    role: ContainerRoles.SqlContainerRead,
    makeClient: ({ get, list, query }) => ({ get, list, query }),
  }),
);
