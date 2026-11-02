import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { toRedacted } from "../internal/dataServices.ts";
import { Connect, type ConnectionInfo } from "./Connect.ts";
import type { Credential } from "./Credential.ts";

/**
 * Implementation of {@link Connect}. It makes no STACKIT API call: everything it
 * resolves comes from the attributes of the bound credential.
 *
 * @layer
 * @provides Stackit.MariaDB.Connect
 */
export const ConnectHttp = Layer.succeed(
  Connect,
  Effect.fn(function* (credential: Credential) {
    const host = yield* credential.host;
    const port = yield* credential.port;
    const database = yield* credential.databaseName;
    const username = yield* credential.username;
    const password = yield* credential.password;
    const uri = yield* credential.uri;
    return Effect.gen(function* () {
      const secret = yield* password;
      const url = yield* uri;
      const info: ConnectionInfo = {
        host: yield* host,
        port: yield* port,
        database: yield* database,
        username: yield* username,
        password: toRedacted(secret),
        url: toRedacted(url),
      };
      return info;
    });
  }),
);
