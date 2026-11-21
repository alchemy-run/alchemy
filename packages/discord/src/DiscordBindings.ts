/**
 * How Discord bindings reach Discord from any host.
 *
 * Discord issues no workload identity and can't mint a scoped or second
 * token for a bot: an application has exactly one bot token, reset only in
 * the Developer Portal. So a host that calls the bot API (a Cloudflare
 * Worker, a Lambda, a container) gets the token the stack deploys with,
 * recorded per host as a `Discord.DeployerToken` and bound into the host's
 * env as a secret (`Redacted`). Inside the deployed host the binding reads
 * it back through `RuntimeContext`; nothing reads `process.env`.
 *
 * Webhook bindings (`ExecuteWebhook` and the webhook message bindings) don't
 * need the bot token at all: they bind only the webhook's own token, and the
 * request goes out without an `Authorization` header. Prefer them for hosts
 * that only post messages.
 */
import { Credentials } from "@distilled.cloud/discord/Credentials";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { DEFAULT_API_BASE_URL } from "./Credentials.ts";
import { DeployerToken } from "./internal/DeployerToken.ts";

/** Runs distilled Discord calls with a host's credentials. */
export type Authorize = <A, E>(
  effect: Effect.Effect<A, E, Credentials | HttpClient.HttpClient>,
) => Effect.Effect<A, E, RuntimeContext>;

/**
 * Record (at deploy) and read back (at run time) the bot token a host's
 * Discord bindings call with. Every bot-token binding on one host shares one
 * record (the engine de-duplicates the declaration).
 */
export const BotAccess = Effect.gen(function* () {
  const Token = yield* DeployerToken;
  return Effect.fn(function* () {
    const host = yield* Binding.Host;
    const token = yield* Token(`${host?.LogicalId ?? "Script"}DiscordBotToken`, {});
    const botToken = yield* token.botToken;
    const apiBaseUrl = yield* token.apiBaseUrl;
    const layer = Layer.mergeAll(
      Layer.succeed(
        Credentials,
        Effect.all([botToken, apiBaseUrl]).pipe(
          Effect.map(([t, url]) => ({
            token: t,
            tokenType: "Bot" as const,
            apiBaseUrl: url || DEFAULT_API_BASE_URL,
          })),
        ),
      ),
      FetchHttpClient.layer,
    );
    const authorize: Authorize = (effect) => effect.pipe(Effect.provide(layer));
    return authorize;
  });
});

/**
 * Calls authenticated by a webhook's own token in the URL: no bot token is
 * bound, and the request carries no `Authorization` header.
 */
export const WebhookAccess = Effect.sync(() => {
  const withoutAuthorization = Layer.effect(
    HttpClient.HttpClient,
    Effect.map(HttpClient.HttpClient, (client) =>
      client.pipe(HttpClient.mapRequest(HttpClientRequest.removeHeader("authorization"))),
    ),
  ).pipe(Layer.provide(FetchHttpClient.layer));
  const layer = Layer.mergeAll(
    Layer.succeed(
      Credentials,
      Effect.succeed({
        token: Redacted.make(""),
        tokenType: "Bot" as const,
        apiBaseUrl: DEFAULT_API_BASE_URL,
      }),
    ),
    withoutAuthorization,
  );
  const authorize: Authorize = (effect) => effect.pipe(Effect.provide(layer));
  return authorize;
});
