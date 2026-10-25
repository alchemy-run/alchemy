import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import type { SchemaGroup } from "./SchemaGroup.ts";
import type { ReadSchemaGroupClient } from "./SchemaGroupRead.ts";
import type { WriteSchemaGroupClient } from "./SchemaGroupWrite.ts";

/** Read-write client for one Schema Registry schema group. */
export interface ReadWriteSchemaGroupClient extends ReadSchemaGroupClient, WriteSchemaGroupClient {}

/**
 * Register and read schemas in an Event Hubs Schema Registry schema group
 * from any host.
 *
 * Binding assigns two roles: **Schema Registry Reader**
 * (`Microsoft.EventHub/namespaces/schemas/read`) on the schema group, and a
 * custom role with only `Microsoft.EventHub/namespaces/schemas/write` on the
 * group's namespace (one `Azure.Authorization.RoleDefinition`,
 * `AzureSchemaRegistryWriter`, per stack). Registration refuses a role
 * assigned on the schema group itself (HTTP 401 `Authorization failed for
 * specified action: SchemaGroupWrite,SchemaWrite`, even with the built-in
 * Schema Registry Contributor), and the built-in Contributor also grants
 * `schemas/delete` and every schema-group action.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * roles go to that identity. On any other host (a Cloudflare Worker, an
 * AWS Lambda) Alchemy creates an Entra service principal for the host,
 * assigns the roles to it, and binds its client secret into the host's env
 * (see `AzureBindings`). Provide {@link SchemaGroupReadWriteHttp}.
 *
 * ### Registering and Reading Schemas
 * **Example:** Register a schema, then read it back by ID
 * ```typescript
 * // init
 * const registry = yield* Azure.EventHub.SchemaGroupReadWrite(schemas);
 *
 * // runtime
 * const { id } = yield* registry.registerSchema("Order", JSON.stringify(orderSchema));
 * const schema = yield* registry.getSchema(id);
 * ```
 *
 * @binding
 * @category EventHub
 */
export interface SchemaGroupReadWrite extends Binding.Service<
  SchemaGroupReadWrite,
  "Azure.EventHub.SchemaGroupReadWrite",
  (group: SchemaGroup) => Effect.Effect<ReadWriteSchemaGroupClient>
> {}

export const SchemaGroupReadWrite = Binding.Service<SchemaGroupReadWrite>(
  "Azure.EventHub.SchemaGroupReadWrite",
);
