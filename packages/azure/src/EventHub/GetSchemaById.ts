import type * as registry from "@distilled.cloud/azure/schemaregistry-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { SchemaGroup } from "./SchemaGroup.ts";

/** A `GetSchemaById` request; the bound schema group supplies the namespace endpoint. */
export interface GetSchemaByIdRequest extends Omit<
  registry.GetSchemaByIdRequest,
  "fullyQualifiedNamespace"
> {}

/** Runtime callable of {@link GetSchemaById}. */
export type GetSchemaByIdClient = (
  request: GetSchemaByIdRequest,
) => Effect.Effect<registry.GetSchemaByIdResponse, registry.GetSchemaByIdError, RuntimeContext>;

/**
 * Read a registered schema by its namespace-unique ID, the ID producers put
 * in their messages. The schema text comes back as bytes (`body`) with its
 * `contentType`, group, name, and version.
 *
 * Binding assigns **Schema Registry Reader** (data action
 * `Microsoft.EventHub/namespaces/schemas/read`) on the schema group only.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity. On any other host (a Cloudflare Worker, an
 * AWS Lambda) Alchemy creates an Entra service principal for the host,
 * assigns the role to it, and binds its client secret into the host's env
 * (see `AzureBindings`).
 * Provide {@link GetSchemaByIdHttp}.
 *
 * ### Reading Schemas
 * **Example:** Resolve the schema of a message
 * ```typescript
 * // Schemas: a module-scope Azure.EventHub.SchemaGroup declaration
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const schemas = yield* Schemas;
 *     // init: assigns Schema Registry Reader on the schema group only
 *     const getSchema = yield* Azure.EventHub.GetSchemaById(schemas);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime: the namespace endpoint is filled in
 *         // schemaId: the ID the producer stamped on the message
 *         const schema = yield* getSchema({ id: schemaId });
 *         const text = new TextDecoder().decode(schema.body);
 *         return HttpServerResponse.text(text);
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.EventHub.GetSchemaByIdHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category EventHub
 */
export interface GetSchemaById extends Binding.Service<
  GetSchemaById,
  "Azure.EventHub.GetSchemaById",
  (group: SchemaGroup) => Effect.Effect<GetSchemaByIdClient>
> {}

export const GetSchemaById = Binding.Service<GetSchemaById>("Azure.EventHub.GetSchemaById");
