import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { toRedacted } from "../OpenSearch/internal.ts";
import { Connect, type ConnectionInfo } from "./Connect.ts";
import type { Credential } from "./Credential.ts";

/**
 * Implementation of {@link Connect}. It makes no STACKIT API call: everything it
 * resolves comes from the attributes of the bound credential.
 *
 * @layer
 * @provides Stackit.LogMe.Connect
 */
export const ConnectHttp = Layer.succeed(
  Connect,
  Effect.fn(function* (credential: Credential) {
    const host = yield* credential.host;
    const port = yield* credential.port;
    const username = yield* credential.username;
    const password = yield* credential.password;
    const uri = yield* credential.uri;
    const drain = yield* credential.syslogDrainUrl;
    return Effect.gen(function* () {
      const secret = yield* password;
      const url = yield* uri;
      const syslogDrainUrl = yield* drain;
      const info: ConnectionInfo = {
        host: yield* host,
        port: yield* port,
        username: yield* username,
        password: toRedacted(secret),
        url: toRedacted(url),
        syslogDrainUrl: syslogDrainUrl === undefined ? undefined : toRedacted(syslogDrainUrl),
      };
      return info;
    });
  }),
);
