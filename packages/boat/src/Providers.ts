import { CredentialsStoreLive } from "alchemy/Auth/Credentials";
import { ProfileStoreLive } from "alchemy/Auth/Profile";
import * as Provider from "alchemy/Provider";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import { AiProxy, AiProxyProvider } from "./AiProxy.ts";
import { ApiKey, ApiKeyProvider } from "./ApiKey.ts";
import { BoatAuth } from "./AuthProvider.ts";
import { CredentialProfile, CredentialProfileProvider } from "./CredentialProfile.ts";
import * as Credentials from "./Credentials.ts";
import { Environment, EnvironmentProvider } from "./Environment.ts";
import { Sandbox, SandboxProvider } from "./Sandbox.ts";
import { Snapshot, SnapshotProvider } from "./Snapshot.ts";
import { Webhook, WebhookProvider } from "./Webhook.ts";

/**
 * Service tag bundling all Boat providers + auth + credentials. Use
 * `Boat.providers()` to materialize the full layer.
 */
export class Providers extends Provider.ProviderCollection<Providers>()("Boat") {}

export type ProviderRequirements = Layer.Services<ReturnType<typeof providers>>;

/**
 * Build the complete Boat providers Layer: every Boat resource, the Boat
 * AuthProvider registration (so `alchemy profile edit` can configure it),
 * and credential resolution.
 *
 * `org` picks the organization (wallet) the stack's resources bill and the
 * one whose shared environments `Boat.Environment` manages: an org id
 * (`team_…`), an org name, or `personal`. It overrides the profile's `org`
 * (or `BOAT_ORG`); with neither, Boat uses the account's active wallet and
 * environments are your personal ones.
 *
 * @example
 * ```ts
 * Alchemy.Stack("App", { providers: Boat.providers() }, ...)
 * Alchemy.Stack("App", { providers: Boat.providers({ org: "team_abc" }) }, ...)
 * ```
 */
export const providers = (options?: { readonly org?: string }) =>
  Layer.effect(
    Providers,
    Provider.collection([
      AiProxy,
      ApiKey,
      CredentialProfile,
      Environment,
      Sandbox,
      Snapshot,
      Webhook,
    ]),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        AiProxyProvider(),
        ApiKeyProvider(),
        CredentialProfileProvider(),
        EnvironmentProvider(),
        SandboxProvider(),
        SnapshotProvider(),
        WebhookProvider(),
      ),
    ),
    Layer.provideMerge(Credentials.fromAuthProvider(options)),
    Layer.provideMerge(FetchHttpClient.layer),
    Layer.provideMerge(BoatAuth),
    Layer.provideMerge(ProfileStoreLive),
    Layer.provideMerge(CredentialsStoreLive),
    Layer.orDie,
  );
