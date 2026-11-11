import { CurrentRuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import type { Cluster } from "./Cluster.ts";
import { Connect, ConnectionStringMissing, type ConnectClient } from "./Connect.ts";
import type { ConnectionPool } from "./ConnectionPool.ts";

const envKeys = (target: { readonly LogicalId: string }) => {
  const id = target.LogicalId.replaceAll(/[^a-zA-Z0-9]/g, "_").toUpperCase();
  return { public: `DO_DATABASE_${id}_URI`, private: `DO_DATABASE_${id}_PRIVATE_URI` };
};

/**
 * `Connect` for any host: the connection URIs travel as secrets through
 * the host's runtime context.
 *
 * @layer
 * @product Managed Databases
 * @provides DigitalOcean.Databases.Connect
 */
export const ConnectHttp = Layer.succeed(
  Connect,
  Effect.fn(function* (target: Cluster | ConnectionPool) {
    const keys = envKeys(target);
    if (!globalThis.__ALCHEMY_RUNTIME__) {
      const runtime = yield* CurrentRuntimeContext;
      if (runtime !== undefined) {
        yield* runtime.set(keys.public, target.uri);
        yield* runtime.set(keys.private, target.privateUri);
      }
    }
    const read = (key: string) =>
      Effect.gen(function* () {
        const runtime = yield* CurrentRuntimeContext;
        const value =
          runtime === undefined
            ? undefined
            : yield* runtime.get<string | Redacted.Redacted<string>>(key);
        if (value === undefined || value === "") {
          return yield* new ConnectionStringMissing({ resourceName: target.LogicalId });
        }
        return typeof value === "string" ? Redacted.make(value) : value;
      });
    return {
      connectionString: read(keys.public),
      privateConnectionString: read(keys.private),
    } satisfies ConnectClient;
  }),
);
