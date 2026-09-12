import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as Provider from "../Provider.ts";
import { BotToken, BotTokenProvider } from "./BotToken.ts";
import * as Credentials from "./Credentials.ts";

export { DiscordCredentials } from "./Credentials.ts";

export class Providers extends Provider.ProviderCollection<Providers>()(
  "Discord",
) {}

export type ProviderRequirements = Layer.Services<ReturnType<typeof providers>>;

/**
 * Discord providers (BotToken) over the ambient bot credential
 * (`DISCORD_BOT_TOKEN`).
 */
export const providers = () =>
  Layer.effect(Providers, Provider.collection([BotToken])).pipe(
    Layer.provide(BotTokenProvider()),
    Layer.provideMerge(Credentials.fromEnv()),
    Layer.provideMerge(FetchHttpClient.layer),
    Layer.orDie,
  );
