import type * as pipes from "@distilled.cloud/clickhouse-cloud/click_pipes";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { ResultMissing } from "../Errors.ts";
import type { Service } from "../Service/Service.ts";

/**
 * Infer the fields and ClickHouse types of a Kafka, Kinesis, Pub/Sub or
 * object storage source at runtime, without creating a pipe: e.g. to
 * propose destination columns before onboarding a new feed. Object storage
 * inference runs on the bound service, which must be running. The
 * endpoint is in beta.
 *
 * The host gets its own API key, with a role that allows only
 * `control-plane:service:view`, `control-plane:service:manage-clickpipes` and
 * `sql-console:database:access` (ClickPipes refuse a key without database
 * access) on the bound service. ClickHouse Cloud federates no workload identity, so
 * a key is the only way in.
 *
 * ### Inferring a Schema
 * **Example:** The columns of a public CSV file
 * ```typescript
 * export default class Onboarding extends Cloudflare.Worker<Onboarding>()(
 *   "Onboarding",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const discover = yield* ClickHouseCloud.ClickPipes.DiscoverClickPipeSchema(Analytics);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime
 *         const schema = yield* discover({
 *           objectStorage: {
 *             type: "s3",
 *             format: "CSVWithNames",
 *             url: "https://datasets-documentation.s3.eu-west-3.amazonaws.com/1brc/stations.csv",
 *           },
 *         });
 *         return yield* HttpServerResponse.json(schema.fields);
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(ClickHouseCloud.ClickPipes.DiscoverClickPipeSchemaHttp)),
 * ) {}
 * ```
 *
 * Uses ClickHouse Cloud API endpoints marked Beta: `discoverClickPipeSchema`.
 *
 * @binding
 * @product ClickPipes
 */
export interface DiscoverClickPipeSchema extends Binding.Service<
  DiscoverClickPipeSchema,
  "ClickHouseCloud.ClickPipes.DiscoverClickPipeSchema",
  (
    target: Service,
  ) => Effect.Effect<
    (
      source: pipes.ClickPipeSchemaDiscoverySource,
    ) => Effect.Effect<
      pipes.ClickPipeSchemaDiscoveryResponse,
      pipes.DiscoverClickPipeSchemaError | ResultMissing,
      RuntimeContext
    >
  >
> {}

export const DiscoverClickPipeSchema = Binding.Service<DiscoverClickPipeSchema>(
  "ClickHouseCloud.ClickPipes.DiscoverClickPipeSchema",
);
