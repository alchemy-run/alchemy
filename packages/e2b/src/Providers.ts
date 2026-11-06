import { CredentialsStoreLive } from "alchemy/Auth/Credentials";
import { ProfileStoreLive } from "alchemy/Auth/Profile";
import * as Provider from "alchemy/Provider";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import { ApiKey, ApiKeyProvider } from "./ApiKey.ts";
import { E2BAuth } from "./AuthProvider.ts";
import * as Credentials from "./Credentials.ts";
import { Sandbox, SandboxProvider } from "./Sandbox.ts";
import { Secret, SecretProvider } from "./Secret.ts";
import { Snapshot, SnapshotProvider } from "./Snapshot.ts";
import { Template, TemplateProvider } from "./Template.ts";
import { Volume, VolumeProvider } from "./Volume.ts";
import { Webhook, WebhookProvider } from "./Webhook.ts";

export { Credentials } from "@distilled.cloud/e2b/Credentials";

export class Providers extends Provider.ProviderCollection<Providers>()("E2B") {}

export type ProviderRequirements = Layer.Services<ReturnType<typeof providers>>;

/**
 * E2B providers and credentials. Wires up every E2B resource and registers
 * the E2B AuthProvider so `alchemy profile edit --add E2B` can configure it.
 */
export const providers = () =>
  Layer.effect(
    Providers,
    Provider.collection([ApiKey, Sandbox, Secret, Snapshot, Template, Volume, Webhook]),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        ApiKeyProvider(),
        SandboxProvider(),
        SecretProvider(),
        SnapshotProvider(),
        TemplateProvider(),
        VolumeProvider(),
        WebhookProvider(),
      ),
    ),
    Layer.provideMerge(Credentials.fromAuthProvider()),
    Layer.provideMerge(FetchHttpClient.layer),
    Layer.provideMerge(E2BAuth),
    Layer.provideMerge(ProfileStoreLive),
    Layer.provideMerge(CredentialsStoreLive),
    Layer.orDie,
  );
