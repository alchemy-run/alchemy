import * as Redis from "@alchemy.run/redis";
import { makeTokenCache, requestManagedIdentityToken } from "@distilled.cloud/azure";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

/** Microsoft Entra ID scope of Azure Managed Redis. */
export const REDIS_SCOPE = "https://redis.azure.com/.default";

/** The managed-identity token has no `oid` (object ID) claim. */
export class TokenObjectIdMissing extends Data.TaggedError("TokenObjectIdMissing")<{
  readonly message: string;
}> {}

/**
 * Azure Managed Redis takes `AUTH <object ID> <token>`. The object ID is
 * the identity's `principalId`, which is also the token's `oid` claim.
 */
const objectIdOf = (token: string) =>
  Effect.try({
    try: () => {
      const payload = token.split(".")[1] ?? "";
      const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
        oid?: unknown;
      };
      if (typeof claims.oid !== "string") throw new Error("the token has no oid claim");
      return claims.oid;
    },
    catch: (cause) => new TokenObjectIdMissing({ message: String(cause) }),
  });

/**
 * A RESP client for an Azure Managed Redis database that signs in as the
 * host's managed identity.
 *
 * Each call opens one TLS connection, sends `AUTH <oid> <token>`, runs its
 * commands, and closes. Tokens come from the host's identity endpoint
 * (`IDENTITY_ENDPOINT` on Azure Functions) and are cached until 5 minutes
 * before they expire, so a request reuses the token of the last one.
 *
 * `endpoint` resolves the database host name and port at request time.
 */
export const makeEntraRedis = <E, R>(
  endpoint: Effect.Effect<{ readonly host: string; readonly port: number }, E, R>,
) => {
  const tokenFor = makeTokenCache((scope: string) => requestManagedIdentityToken({}, scope));

  const url = Effect.gen(function* () {
    const { host, port } = yield* endpoint;
    const redacted = yield* tokenFor(REDIS_SCOPE);
    const token = Redacted.value(redacted);
    const objectId = yield* objectIdOf(token);
    return Redis.connectionUrl({ host, port, username: objectId, password: token, tls: true });
  });

  return {
    /** Send one command. */
    send: (name: string, args: readonly Redis.Arg[] = []) =>
      Effect.flatMap(url, (resolved) => Redis.run(resolved, name, args)),
    /** Send several commands in one round trip, on one connection. */
    pipeline: (commands: ReadonlyArray<readonly [string, ...Redis.Arg[]]>) =>
      Effect.flatMap(url, (resolved) => Redis.pipeline(resolved, commands)),
  };
};
