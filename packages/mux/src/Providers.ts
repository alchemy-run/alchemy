import * as MuxRetry from "@distilled.cloud/mux/Retry";
import { CredentialsStoreLive } from "alchemy/Auth/Credentials";
import { ProfileStoreLive } from "alchemy/Auth/Profile";
import * as DeployRetry from "alchemy/DeployRetry";
import * as Provider from "alchemy/Provider";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import { MuxAuth } from "./AuthProvider.ts";
import * as Credentials from "./Credentials.ts";
import { Webhook, WebhookProvider } from "./System/Webhook.ts";

export class Providers extends Provider.ProviderCollection<Providers>()("Mux") {}

export type ProviderRequirements = Layer.Services<ReturnType<typeof providers>>;

/**
 * Mux providers and credentials. Registers the Mux AuthProvider so
 * `alchemy profile edit` can configure an access token.
 */
export const providers = () =>
  Layer.effect(Providers, Provider.collection([Webhook])).pipe(
    Layer.provide(Layer.mergeAll(WebhookProvider())),
    Layer.provideMerge(Layer.succeed(MuxRetry.Retry, DeployRetry.policy)),
    Layer.provideMerge(Credentials.fromAuthProvider()),
    Layer.provideMerge(FetchHttpClient.layer),
    Layer.provideMerge(MuxAuth),
    Layer.provideMerge(ProfileStoreLive),
    Layer.provideMerge(CredentialsStoreLive),
    Layer.orDie,
  );
