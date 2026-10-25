import type * as registry from "@distilled.cloud/azure/schemaregistry-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { SchemaGroup } from "./SchemaGroup.ts";

/** A `RegisterSchema` request; the bound schema group supplies the endpoint and group name. */
export interface RegisterSchemaRequest extends Omit<
  registry.RegisterSchemaRequest,
  "fullyQualifiedNamespace" | "groupName"
> {}

/** Runtime callable of {@link RegisterSchema}. */
export type RegisterSchemaClient = (
  request: RegisterSchemaRequest,
) => Effect.Effect<registry.RegisterSchemaResponse, registry.RegisterSchemaError, RuntimeContext>;

/**
 * Register a schema in a Schema Registry schema group. A new name starts at
 * version 1; registering new content under an existing name adds the next
 * version, and registering identical content returns the existing version.
 * The schema's identity (`schemaId`, `schemaVersion`) comes back in the
 * response.
 *
 * Binding assigns a custom role with only the data action
 * `Microsoft.EventHub/namespaces/schemas/write` on the group's namespace:
 * one `Azure.Authorization.RoleDefinition` (`AzureSchemaRegistryWriter`) per
 * stack, shared by every host. Registration refuses a role assigned on the
 * schema group itself (HTTP 401 `Authorization failed for specified action:
 * SchemaGroupWrite,SchemaWrite`, even with the built-in Schema Registry
 * Contributor), and the built-in Contributor also grants `schemas/delete`
 * and every schema-group action.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity. On any other host (a Cloudflare Worker, an
 * AWS Lambda) Alchemy creates an Entra service principal for the host,
 * assigns the role to it, and binds its client secret into the host's env
 * (see `AzureBindings`). Provide {@link RegisterSchemaHttp}.
 *
 * ### Registering Schemas
 * **Example:** Register an Avro schema
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     // init: assigns the role on the schema group
 *     const register = yield* Azure.EventHub.RegisterSchema(schemas);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime: the endpoint and group name are filled in
 *         const { schemaId, schemaVersion } = yield* register({
 *           schemaName: "Order",
 *           contentType: "application/json; serialization=Avro",
 *           body: JSON.stringify(orderSchema),
 *         });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.EventHub.RegisterSchemaHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category EventHub
 */
export interface RegisterSchema extends Binding.Service<
  RegisterSchema,
  "Azure.EventHub.RegisterSchema",
  (group: SchemaGroup) => Effect.Effect<RegisterSchemaClient>
> {}

export const RegisterSchema = Binding.Service<RegisterSchema>("Azure.EventHub.RegisterSchema");
