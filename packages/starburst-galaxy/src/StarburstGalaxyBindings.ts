/**
 * How Starburst Galaxy bindings reach the Galaxy API from any host.
 *
 * Galaxy authenticates API calls only with OAuth client credentials of an
 * API client made in its console (Access → API auth token): its public API
 * has no operation to create an API client or a token, and Galaxy trusts no
 * OIDC issuer or workload identity, so no host can federate into it and no
 * per-host key can be minted. A host therefore calls Galaxy as the
 * deploying profile's API client: its domain, client ID and client secret
 * are bound into the host at deploy (the secret as a `Redacted` value
 * through `RuntimeContext`, so it deploys as a secret), and the host
 * exchanges them for ten-minute access tokens itself. The client's role
 * bounds what every binding on the host may do: deploy hosts from a
 * profile whose API client holds a role with only the privileges they need.
 */
import { ConfigError } from "@distilled.cloud/core/errors";
import { Credentials } from "@distilled.cloud/starburst-galaxy/Credentials";
import { orDieCredentialsUnavailable } from "alchemy/Auth/Resolve";
import * as Output from "alchemy/Output";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import type * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import { DeployClient, tokensFor } from "./Credentials.ts";

/** A plain value as an Output with no requirements (`asOutput` leaves them `any`). */
const output = <A>(value: A) => Output.asOutput(value) as Output.Output<A, never>;

/** Runs Galaxy SDK calls on a host with the bound API client. */
export interface StarburstGalaxyAccess {
  /** Provides `Credentials` and an `HttpClient`; the result requires only `RuntimeContext`. */
  readonly authorize: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, Exclude<R, Credentials | HttpClient.HttpClient> | RuntimeContext>;
}

/**
 * Bind the deploying profile's API client into the current host and
 * return the runtime accessor for it. Call it in a binding's construction;
 * every Galaxy binding on a host shares the one client.
 */
export const bindStarburstGalaxy = Effect.gen(function* () {
  let domain = "";
  let clientId = "";
  let clientSecret = Redacted.make("");
  if (!globalThis.__ALCHEMY_RUNTIME__) {
    const resolve = yield* Effect.serviceOption(DeployClient);
    if (Option.isNone(resolve)) {
      return yield* Effect.die(
        new ConfigError({
          message:
            "Starburst Galaxy bindings need StarburstGalaxy.providers() in the stack, to bind the deploying API client into the host",
        }),
      );
    }
    const client = yield* resolve.value.pipe(orDieCredentialsUnavailable("StarburstGalaxy"));
    domain = client.domain;
    clientId = client.clientId;
    clientSecret = client.clientSecret;
  }
  const boundDomain = yield* Output.named(output(domain), "STARBURST_GALAXY_DOMAIN").asEffect();
  const boundClientId = yield* Output.named(
    output(clientId),
    "STARBURST_GALAXY_CLIENT_ID",
  ).asEffect();
  const boundSecret = yield* Output.named(
    output(clientSecret),
    "STARBURST_GALAXY_CLIENT_SECRET",
  ).asEffect();

  // One token cache per host instance, filled on first use.
  const client = Effect.gen(function* () {
    return {
      domain: yield* boundDomain,
      clientId: yield* boundClientId,
      clientSecret: yield* boundSecret,
    };
  });
  const tokens = yield* tokensFor(client).pipe(Effect.provide(FetchHttpClient.layer));

  return {
    authorize: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.gen(function* () {
        const context = yield* Effect.context<RuntimeContext>();
        const credentials = Layer.succeed(Credentials, tokens.pipe(Effect.provideContext(context)));
        return yield* effect.pipe(
          Effect.provide(Layer.mergeAll(credentials, FetchHttpClient.layer)),
        );
      }),
  } satisfies StarburstGalaxyAccess;
});
