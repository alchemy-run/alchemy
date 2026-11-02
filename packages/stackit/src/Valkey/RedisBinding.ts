import type { Url } from "@alchemy.run/redis/Client";
import { UrlMissing } from "@alchemy.run/redis/Errors";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import type { Credential } from "./Credential.ts";

/**
 * Shared scaffolding for the RESP bindings, on the `@alchemy.run/redis` client.
 * NOT exported from index.ts.
 *
 * Valkey authenticates with the credential, so these bindings grant no STACKIT role
 * and create no service account: the credential's attributes travel through the
 * host's environment, with the password and URI kept `Redacted`.
 *
 * The URI STACKIT hands out decides the scheme, so TLS too. `valkey://` and
 * `valkeys://` mean what `redis://` and `rediss://` do. A URI with another scheme fails
 * with `UrlMissing`: anything built without it could send the password in the clear to
 * an instance that asked for TLS.
 */

const reveal = (value: string | Redacted.Redacted<string>): string =>
  Redacted.isRedacted(value) ? Redacted.value(value) : value;

/** The URI as a URL the client reads, or `undefined` for a scheme it can't speak. */
export const toRedisUrl = (uri: string): string | undefined => {
  if (uri.startsWith("redis://") || uri.startsWith("rediss://")) return uri;
  if (uri.startsWith("valkey://")) return `redis://${uri.slice("valkey://".length)}`;
  if (uri.startsWith("valkeys://")) return `rediss://${uri.slice("valkeys://".length)}`;
  return undefined;
};

export const makeValkeyBinding = <Client>(options: { makeClient: (url: Url) => Client }) =>
  Effect.succeed(
    Effect.fn(function* (credential: Credential) {
      const uri = yield* credential.uri;
      const url: Url = Effect.gen(function* () {
        const resolved = yield* uri;
        if (resolved === undefined) {
          return yield* new UrlMissing({ resourceName: credential.LogicalId });
        }
        const plain = reveal(resolved);
        const redisUrl = toRedisUrl(plain);
        if (redisUrl !== undefined) return redisUrl;
        // The scheme only: the rest of a URI holds the password.
        const scheme = /^[A-Za-z][A-Za-z0-9+.-]*:/.exec(plain)?.[0] ?? "no scheme";
        return yield* new UrlMissing({
          resourceName: credential.LogicalId,
          reason: `its URI has ${scheme}, which isn't a Redis scheme`,
        });
      });
      return options.makeClient(url);
    }),
  );
