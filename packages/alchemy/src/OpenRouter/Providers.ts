import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import { CredentialsStoreLive } from "../Auth/Credentials.ts";
import { ProfileStoreLive } from "../Auth/Profile.ts";
import * as Provider from "../Provider.ts";
import { ApiKey, ApiKeyProvider } from "./ApiKey.ts";
import { OpenRouterAuth } from "./AuthProvider.ts";
import * as Credentials from "./Credentials.ts";
import { Guardrail, GuardrailProvider } from "./Guardrail.ts";

/**
 * Service tag bundling the OpenRouter providers + auth + credentials. Use
 * `OpenRouter.providers()` to materialize the full layer.
 */
export class Providers extends Provider.ProviderCollection<Providers>()("OpenRouter") {}

export type ProviderRequirements = Layer.Services<ReturnType<typeof providers>>;

/**
 * OpenRouter providers and credentials. Wires up the ApiKey and Guardrail
 * resources and registers the OpenRouter AuthProvider so
 * `alchemy profile edit` can configure it.
 *
 * @example
 * ```ts
 * Effect.provide(OpenRouter.providers())
 * ```
 */
export const providers = () =>
  Layer.effect(Providers, Provider.collection([ApiKey, Guardrail])).pipe(
    Layer.provide(Layer.mergeAll(ApiKeyProvider(), GuardrailProvider())),
    Layer.provideMerge(Credentials.fromAuthProvider()),
    Layer.provideMerge(FetchHttpClient.layer),
    Layer.provideMerge(OpenRouterAuth),
    Layer.provideMerge(ProfileStoreLive),
    Layer.provideMerge(CredentialsStoreLive),
    Layer.orDie,
  );
