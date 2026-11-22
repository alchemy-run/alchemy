import type * as registry from "@distilled.cloud/azure/schemaregistry-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { SchemaGroup } from "./SchemaGroup.ts";

/** A `ListSchemaVersions` request; the bound schema group supplies the endpoint and group name. */
export interface ListSchemaVersionsRequest extends Omit<
  registry.ListSchemaVersionsRequest,
  "fullyQualifiedNamespace" | "groupName"
> {}

/** Runtime callable of {@link ListSchemaVersions}. */
export type ListSchemaVersionsClient = (
  request: ListSchemaVersionsRequest,
) => Effect.Effect<registry.SchemaVersions, registry.ListSchemaVersionsError, RuntimeContext>;

/**
 * List the version numbers of one schema in a Schema Registry schema group,
 * one page at a time (pass the previous page's `NextLink` as `nextLink`).
 *
 * Binding assigns **Schema Registry Reader** (data action
 * `Microsoft.EventHub/namespaces/schemas/read`) on the schema group only.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity. On any other host (a Cloudflare Worker, an
 * AWS Lambda) Alchemy creates an Entra service principal for the host,
 * assigns the role to it, and binds its client secret into the host's env
 * (see `AzureBindings`).
 * Provide {@link ListSchemaVersionsHttp}.
 *
 * ### Listing Versions
 * **Example:** List the versions of a schema
 * ```typescript
 * // Schemas: a module-scope Azure.EventHub.SchemaGroup declaration
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const schemas = yield* Schemas;
 *     // init: assigns Schema Registry Reader on the schema group only
 *     const listVersions = yield* Azure.EventHub.ListSchemaVersions(schemas);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime: the endpoint and group name are filled in
 *         const { Value: versions } = yield* listVersions({ schemaName: "Order" });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.EventHub.ListSchemaVersionsHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category EventHub
 */
export interface ListSchemaVersions extends Binding.Service<
  ListSchemaVersions,
  "Azure.EventHub.ListSchemaVersions",
  (group: SchemaGroup) => Effect.Effect<ListSchemaVersionsClient>
> {}

export const ListSchemaVersions = Binding.Service<ListSchemaVersions>(
  "Azure.EventHub.ListSchemaVersions",
);
