import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { SchemaGroup } from "./SchemaGroup.ts";
import type {
  Schema,
  SchemaFormat,
  SchemaProperties,
  SchemaReadError,
} from "./SchemaRegistryTypes.ts";

/** Read-only client for one Schema Registry schema group. */
export interface ReadSchemaGroupClient {
  /** Read a schema by its namespace-unique ID (the ID producers stamp on messages). */
  getSchema(id: string): Effect.Effect<Schema, SchemaReadError, RuntimeContext>;
  /** Read one version (1, 2, …) of a schema in the group. */
  getSchemaVersion(
    schemaName: string,
    version: number,
  ): Effect.Effect<Schema, SchemaReadError, RuntimeContext>;
  /**
   * Find the ID and version of already-registered `content` without
   * registering it. `format` is `Avro`, `Json`, `Protobuf`, or `Custom`; it
   * defaults to the group's `schemaType` (`Custom` for any other type).
   */
  getSchemaProperties(
    schemaName: string,
    content: string,
    format?: SchemaFormat,
  ): Effect.Effect<SchemaProperties, SchemaReadError, RuntimeContext>;
  /** Every version number of a schema, oldest first (reads every page). */
  listSchemaVersions(schemaName: string): Effect.Effect<number[], SchemaReadError, RuntimeContext>;
}

/**
 * Read schemas from an Event Hubs Schema Registry schema group from any
 * host: by ID, by version, by content, and the list of versions.
 *
 * Binding assigns **Schema Registry Reader** (data action
 * `Microsoft.EventHub/namespaces/schemas/read`) on the schema group only.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity. On any other host (a Cloudflare Worker, an
 * AWS Lambda) Alchemy creates an Entra service principal for the host,
 * assigns the role to it, and binds its client secret into the host's env
 * (see `AzureBindings`). Provide {@link SchemaGroupReadHttp}.
 *
 * ### Reading Schemas
 * **Example:** Resolve the schema of a message
 * ```typescript
 * // Schemas: a module-scope Azure.EventHub.SchemaGroup declaration
 * export default class Consumer extends Azure.Functions.Function<Consumer>()(
 *   "Consumer",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const schemas = yield* Schemas;
 *     // init: assigns Schema Registry Reader on the schema group only
 *     const registry = yield* Azure.EventHub.SchemaGroupRead(schemas);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime
 *         // schemaId: the ID the producer stamped on the message
 *         const schema = yield* registry.getSchema(schemaId);
 *         const avro = JSON.parse(schema.content);
 *         return yield* HttpServerResponse.json(avro);
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.EventHub.SchemaGroupReadHttp)),
 * ) {}
 * ```
 *
 * **Example:** List and read the versions of a schema
 * ```typescript
 * // runtime, inside the host above
 * const versions = yield* registry.listSchemaVersions("Order");
 * const latest = yield* registry.getSchemaVersion("Order", versions.at(-1)!);
 * ```
 *
 * @binding
 * @category EventHub
 */
export interface SchemaGroupRead extends Binding.Service<
  SchemaGroupRead,
  "Azure.EventHub.SchemaGroupRead",
  (group: SchemaGroup) => Effect.Effect<ReadSchemaGroupClient>
> {}

export const SchemaGroupRead = Binding.Service<SchemaGroupRead>("Azure.EventHub.SchemaGroupRead");
