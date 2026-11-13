import { CurrentRuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import type { Cluster } from "./Cluster.ts";
import { Connect, ConnectionStringMissing, type ConnectClient } from "./Connect.ts";
import type { ConnectionPool } from "./ConnectionPool.ts";
import type { Database } from "./Database.ts";

const envKeys = (target: { readonly LogicalId: string }) => {
  const id = target.LogicalId.replaceAll(/[^a-zA-Z0-9]/g, "_").toUpperCase();
  return {
    public: `DO_DATABASE_${id}_URI`,
    private: `DO_DATABASE_${id}_PRIVATE_URI`,
    ca: `DO_DATABASE_${id}_CA`,
  };
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
  Effect.fn(function* (target: Cluster | ConnectionPool | Database) {
    const keys = envKeys(target);
    if (!globalThis.__ALCHEMY_RUNTIME__) {
      const runtime = yield* CurrentRuntimeContext;
      if (runtime !== undefined) {
        yield* runtime.set(keys.public, target.uri);
        yield* runtime.set(keys.private, target.privateUri);
        yield* runtime.set(keys.ca, target.caCertificate);
      }
    }
    // Read in the construction phase, where the host's runtime context is
    // present; request handlers close over the values.
    const runtime = globalThis.__ALCHEMY_RUNTIME__ ? yield* CurrentRuntimeContext : undefined;
    const lookup = Effect.fn(function* (key: string) {
      return runtime === undefined
        ? undefined
        : yield* runtime.get<string | Redacted.Redacted<string>>(key);
    });
    const boundPublic = yield* lookup(keys.public);
    const boundPrivate = yield* lookup(keys.private);
    const boundCa = yield* lookup(keys.ca);
    const read = (value: string | Redacted.Redacted<string> | undefined) =>
      value === undefined || value === ""
        ? Effect.fail(new ConnectionStringMissing({ resourceName: target.LogicalId }))
        : Effect.succeed(typeof value === "string" ? Redacted.make(value) : value);
    return {
      connectionString: read(boundPublic),
      privateConnectionString: read(boundPrivate),
      caCertificate: Effect.map(read(boundCa), Redacted.value),
    } satisfies ConnectClient;
  }),
);
