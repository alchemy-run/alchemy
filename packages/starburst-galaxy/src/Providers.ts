import { CredentialsStoreLive } from "alchemy/Auth/Credentials";
import { ProfileStoreLive } from "alchemy/Auth/Profile";
import * as Provider from "alchemy/Provider";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import { StarburstGalaxyAuth } from "./AuthProvider.ts";
import * as Credentials from "./Credentials.ts";

/**
 * Service tag bundling every Starburst Galaxy provider, the AuthProvider
 * and credential resolution. Use `StarburstGalaxy.providers()` to build it.
 */
export class Providers extends Provider.ProviderCollection<Providers>()("StarburstGalaxy") {}

export type ProviderRequirements = Layer.Services<ReturnType<typeof providers>>;

/**
 * Starburst Galaxy providers and credentials. Registers the Starburst
 * Galaxy AuthProvider so `alchemy profile edit` can configure it.
 *
 * @example
 * ```ts
 * Effect.provide(StarburstGalaxy.providers())
 * ```
 */
export const providers = () =>
  Layer.effect(Providers, Provider.collection([])).pipe(
    Layer.provideMerge(Credentials.fromAuthProvider()),
    Layer.provideMerge(FetchHttpClient.layer),
    Layer.provideMerge(StarburstGalaxyAuth),
    Layer.provideMerge(ProfileStoreLive),
    Layer.provideMerge(CredentialsStoreLive),
    Layer.orDie,
  );
