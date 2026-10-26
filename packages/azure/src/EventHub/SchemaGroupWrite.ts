import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { SchemaGroup } from "./SchemaGroup.ts";
import type { SchemaFormat, SchemaProperties, SchemaWriteError } from "./SchemaRegistryTypes.ts";

/** Write-only client for one Schema Registry schema group. */
export interface WriteSchemaGroupClient {
  /**
   * Register `content` under `schemaName`. A new name starts at version 1;
   * new content under an existing name adds the next version; identical
   * content returns the existing version. `format` is `Avro`, `Json`,
   * `Protobuf`, or `Custom`; it defaults to the group's `schemaType`
   * (`Custom` for any other type).
   */
  registerSchema(
    schemaName: string,
    content: string,
    format?: SchemaFormat,
  ): Effect.Effect<SchemaProperties, SchemaWriteError, RuntimeContext>;
}

/**
 * Register schemas in an Event Hubs Schema Registry schema group from any
 * host.
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
 * (see `AzureBindings`). Provide {@link SchemaGroupWriteHttp}.
 *
 * ### Registering Schemas
 * **Example:** Register an Avro schema from a producer
 * ```typescript
 * // Schemas: a module-scope Azure.EventHub.SchemaGroup declaration
 * const orderSchema = {
 *   type: "record",
 *   name: "Order",
 *   fields: [{ name: "id", type: "string" }],
 * };
 *
 * export default class Producer extends Azure.Functions.Function<Producer>()(
 *   "Producer",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const schemas = yield* Schemas;
 *     // init: assigns the schemas/write role on the group's namespace
 *     const registry = yield* Azure.EventHub.SchemaGroupWrite(schemas);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime: the format defaults to the group's schemaType
 *         const { id, version } = yield* registry.registerSchema(
 *           "Order",
 *           JSON.stringify(orderSchema),
 *         );
 *         return yield* HttpServerResponse.json({ id, version });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.EventHub.SchemaGroupWriteHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category EventHub
 */
export interface SchemaGroupWrite extends Binding.Service<
  SchemaGroupWrite,
  "Azure.EventHub.SchemaGroupWrite",
  (group: SchemaGroup) => Effect.Effect<WriteSchemaGroupClient>
> {}

export const SchemaGroupWrite = Binding.Service<SchemaGroupWrite>(
  "Azure.EventHub.SchemaGroupWrite",
);
