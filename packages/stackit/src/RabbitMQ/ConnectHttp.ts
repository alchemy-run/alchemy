import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { toRedacted } from "../internal/dataServices.ts";
import { Connect, type ConnectionInfo } from "./Connect.ts";
import type { Credential } from "./Credential.ts";

/**
 * Implementation of {@link Connect}. It makes no API call: everything it resolves
 * comes from the attributes of the bound credential.
 *
 * @layer
 * @provides Stackit.RabbitMQ.Connect
 */
export const ConnectHttp = Layer.succeed(
  Connect,
  Effect.fn(function* (credential: Credential) {
    const host = yield* credential.host;
    const hosts = yield* credential.hosts;
    const port = yield* credential.port;
    const username = yield* credential.username;
    const password = yield* credential.password;
    const uri = yield* credential.uri;
    const uris = yield* credential.uris;
    const httpApiUri = yield* credential.httpApiUri;
    return Effect.gen(function* () {
      const management = yield* httpApiUri;
      const secret = yield* password;
      const address = yield* uri;
      const addresses = yield* uris;
      const info: ConnectionInfo = {
        host: yield* host,
        hosts: yield* hosts,
        port: yield* port,
        username: yield* username,
        // A host's env can hand a secret back unwrapped, whatever its type says.
        password: toRedacted(secret),
        uri: toRedacted(address),
        uris: addresses.map(toRedacted),
        httpApiUri: management === undefined ? undefined : toRedacted(management),
      };
      return info;
    });
  }),
);
