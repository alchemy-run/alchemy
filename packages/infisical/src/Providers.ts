import { CredentialsStoreLive } from "alchemy/Auth/Credentials";
import { ProfileStoreLive } from "alchemy/Auth/Profile";
import * as Provider from "alchemy/Provider";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import { InfisicalAuth } from "./AuthProvider.ts";
import * as Credentials from "./Credentials.ts";
import { ProjectIdentity, ProjectIdentityProvider } from "./ProjectIdentity.ts";
import { Secret, SecretProvider } from "./Secret.ts";

export { Credentials } from "@distilled.cloud/infisical/Credentials";

export class Providers extends Provider.ProviderCollection<Providers>()("Infisical") {}

export type ProviderRequirements = Layer.Services<ReturnType<typeof providers>>;

/** Infisical resource providers, credentials, and profile authentication. */
export const providers = () =>
  Layer.effect(Providers, Provider.collection([ProjectIdentity, Secret])).pipe(
    Layer.provide(Layer.mergeAll(ProjectIdentityProvider(), SecretProvider())),
    Layer.provideMerge(Credentials.fromAuthProvider()),
    Layer.provideMerge(FetchHttpClient.layer),
    Layer.provideMerge(InfisicalAuth),
    Layer.provideMerge(ProfileStoreLive),
    Layer.provideMerge(CredentialsStoreLive),
    Layer.orDie,
  );
