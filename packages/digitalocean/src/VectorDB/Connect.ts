import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Data from "effect/Data";
import type * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import type { Database } from "./Database.ts";

/** The vector database's endpoint or key is missing from this runtime. */
export class VectorDatabaseNotBound extends Data.TaggedError("DigitalOcean.VectorDB.NotBound")<{
  readonly database: string;
}> {
  override get message() {
    return `Vector database '${this.database}' is not bound to this runtime.`;
  }
}

export interface ConnectClient {
  /** HTTPS endpoint of the Weaviate API. */
  readonly httpEndpoint: Effect.Effect<string, VectorDatabaseNotBound, RuntimeContext>;
  /** gRPC endpoint, `host:443`. */
  readonly grpcEndpoint: Effect.Effect<string, VectorDatabaseNotBound, RuntimeContext>;
  /** API key: send as `Authorization: Bearer <key>`. */
  readonly apiKey: Effect.Effect<Redacted.Redacted<string>, VectorDatabaseNotBound, RuntimeContext>;
}

/**
 * Connect a runtime to a managed vector database. Its endpoints and API key
 * reach the host as secrets, for the Weaviate client of your choice.
 *
 * **Example:** Query with `weaviate-client`
 * ```typescript
 * export default class Api extends DigitalOcean.App<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const db = yield* Vectors;
 *     const conn = yield* DigitalOcean.VectorDB.Connect(db);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const url = yield* conn.httpEndpoint;
 *         const key = yield* conn.apiKey;
 *         const live = yield* Effect.tryPromise(async () => {
 *           const client = await weaviate.connectToWeaviateCloud(url, {
 *             authCredentials: new weaviate.ApiKey(Redacted.value(key)),
 *           });
 *           return client.isLive();
 *         });
 *         return HttpServerResponse.text(String(live));
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(DigitalOcean.VectorDB.ConnectHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product Vector Databases
 */
export interface Connect extends Binding.Service<
  Connect,
  "DigitalOcean.VectorDB.Connect",
  (db: Database) => Effect.Effect<ConnectClient>
> {}

export const Connect = Binding.Service<Connect>("DigitalOcean.VectorDB.Connect");
