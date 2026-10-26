import type * as registry from "@distilled.cloud/azure/schemaregistry-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { SchemaGroup } from "./SchemaGroup.ts";

/** A `GetSchemaByVersion` request; the bound schema group supplies the endpoint and group name. */
export interface GetSchemaByVersionRequest extends Omit<
  registry.GetSchemaByVersionRequest,
  "fullyQualifiedNamespace" | "groupName"
> {}

/** Runtime callable of {@link GetSchemaByVersion}. */
export type GetSchemaByVersionClient = (
  request: GetSchemaByVersionRequest,
) => Effect.Effect<
  registry.GetSchemaByVersionResponse,
  registry.GetSchemaByVersionError,
  RuntimeContext
>;

/**
 * Read one version of a schema in a Schema Registry schema group. The schema
 * text comes back as bytes (`body`) with its `contentType` and `schemaId`.
 *
 * Binding assigns **Schema Registry Reader** (data action
 * `Microsoft.EventHub/namespaces/schemas/read`) on the schema group only.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity. On any other host (a Cloudflare Worker, an
 * AWS Lambda) Alchemy creates an Entra service principal for the host,
 * assigns the role to it, and binds its client secret into the host's env
 * (see `AzureBindings`).
 * Provide {@link GetSchemaByVersionHttp}.
 *
 * ### Reading Schemas
 * **Example:** Read version 2 of a schema
 * ```typescript
 * // Schemas: a module-scope Azure.EventHub.SchemaGroup declaration
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const schemas = yield* Schemas;
 *     // init: assigns Schema Registry Reader on the schema group only
 *     const getVersion = yield* Azure.EventHub.GetSchemaByVersion(schemas);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime: the endpoint and group name are filled in
 *         const schema = yield* getVersion({ schemaName: "Order", schemaVersion: 2 });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.EventHub.GetSchemaByVersionHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category EventHub
 */
export interface GetSchemaByVersion extends Binding.Service<
  GetSchemaByVersion,
  "Azure.EventHub.GetSchemaByVersion",
  (group: SchemaGroup) => Effect.Effect<GetSchemaByVersionClient>
> {}

export const GetSchemaByVersion = Binding.Service<GetSchemaByVersion>(
  "Azure.EventHub.GetSchemaByVersion",
);
