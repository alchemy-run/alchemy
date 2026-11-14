import { CurrentRuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { Connect, VectorDatabaseNotBound, type ConnectClient } from "./Connect.ts";
import type { Database } from "./Database.ts";

const envKey = (db: Database, field: string) =>
  `DO_VECTORDB_${db.LogicalId}_${field}`.toUpperCase().replaceAll(/[^A-Z0-9]/g, "_");

/**
 * `VectorDB.Connect` for any host: the endpoints and API key travel through
 * the host's runtime context.
 *
 * @layer
 * @product Vector Databases
 * @provides DigitalOcean.VectorDB.Connect
 */
export const ConnectHttp = Layer.succeed(
  Connect,
  Effect.fn(function* (db: Database) {
    if (!globalThis.__ALCHEMY_RUNTIME__) {
      const runtime = yield* CurrentRuntimeContext;
      if (runtime !== undefined) {
        yield* runtime.set(envKey(db, "http"), db.httpEndpoint);
        yield* runtime.set(envKey(db, "grpc"), db.grpcEndpoint);
        yield* runtime.set(envKey(db, "key"), db.apiKey);
      }
    }
    // Read in the construction phase, where the host's runtime context is
    // present; request handlers close over the values.
    const runtime = globalThis.__ALCHEMY_RUNTIME__ ? yield* CurrentRuntimeContext : undefined;
    const read = Effect.fn(function* (field: string) {
      return runtime === undefined
        ? undefined
        : yield* runtime.get<string | Redacted.Redacted<string>>(envKey(db, field));
    });
    const http = yield* read("http");
    const grpc = yield* read("grpc");
    const key = yield* read("key");
    const missing = new VectorDatabaseNotBound({ database: db.LogicalId });
    const text = (value: string | Redacted.Redacted<string> | undefined) =>
      value === undefined || value === ""
        ? Effect.fail(missing)
        : Effect.succeed(typeof value === "string" ? value : Redacted.value(value));
    return {
      httpEndpoint: text(http),
      grpcEndpoint: text(grpc),
      apiKey:
        key === undefined
          ? Effect.fail(missing)
          : Effect.succeed(typeof key === "string" ? Redacted.make(key) : key),
    } satisfies ConnectClient;
  }),
);
