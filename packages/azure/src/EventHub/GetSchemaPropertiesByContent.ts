import type * as registry from "@distilled.cloud/azure/schemaregistry-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { SchemaGroup } from "./SchemaGroup.ts";

/**
 * A `GetSchemaPropertiesByContent` request; the bound schema group supplies
 * the endpoint and group name.
 */
export interface GetSchemaPropertiesByContentRequest extends Omit<
  registry.GetSchemaPropertiesByContentRequest,
  "fullyQualifiedNamespace" | "groupName"
> {}

/** Runtime callable of {@link GetSchemaPropertiesByContent}. */
export type GetSchemaPropertiesByContentClient = (
  request: GetSchemaPropertiesByContentRequest,
) => Effect.Effect<
  registry.GetSchemaPropertiesByContentResponse,
  registry.GetSchemaPropertiesByContentError,
  RuntimeContext
>;

/**
 * Look up the ID and version of an already-registered schema by its content,
 * without registering it. Producers that ship their schema use it to find
 * the ID to stamp on messages.
 *
 * Binding assigns **Schema Registry Reader** (data action
 * `Microsoft.EventHub/namespaces/schemas/read`) on the schema group only.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity. On any other host (a Cloudflare Worker, an
 * AWS Lambda) Alchemy creates an Entra service principal for the host,
 * assigns the role to it, and binds its client secret into the host's env
 * (see `AzureBindings`).
 * Provide {@link GetSchemaPropertiesByContentHttp}.
 *
 * ### Looking Up Schemas
 * **Example:** Find the ID of a known schema
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     // init: assigns the role on the schema group
 *     const lookup = yield* Azure.EventHub.GetSchemaPropertiesByContent(schemas);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime: the endpoint and group name are filled in
 *         const { schemaId } = yield* lookup({
 *           schemaName: "Order",
 *           contentType: "application/json; serialization=Avro",
 *           body: JSON.stringify(orderSchema),
 *         });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.EventHub.GetSchemaPropertiesByContentHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category EventHub
 */
export interface GetSchemaPropertiesByContent extends Binding.Service<
  GetSchemaPropertiesByContent,
  "Azure.EventHub.GetSchemaPropertiesByContent",
  (group: SchemaGroup) => Effect.Effect<GetSchemaPropertiesByContentClient>
> {}

export const GetSchemaPropertiesByContent = Binding.Service<GetSchemaPropertiesByContent>(
  "Azure.EventHub.GetSchemaPropertiesByContent",
);
