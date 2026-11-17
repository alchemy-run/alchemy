import { CredentialsStoreLive } from "alchemy/Auth/Credentials";
import { ProfileStoreLive } from "alchemy/Auth/Profile";
import * as Provider from "alchemy/Provider";
import { Random, RandomProvider } from "alchemy/Random";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import { App, AppProvider } from "./App.ts";
import { ModalAuth } from "./AuthProvider.ts";
import * as Credentials from "./Credentials.ts";
import { Dict, DictProvider } from "./Dict.ts";
import { Domain, DomainProvider } from "./Domain.ts";
import { Endpoint, EndpointProvider } from "./Endpoint.ts";
import { Environment, EnvironmentProvider } from "./Environment.ts";
import { Function, FunctionProvider } from "./Function.ts";
import { FunctionAutoscaler, FunctionAutoscalerProvider } from "./FunctionAutoscaler.ts";
import { Image, ImageProvider } from "./Image.ts";
import { PersistentSandbox, PersistentSandboxProvider } from "./PersistentSandbox.ts";
import { Proxy, ProxyProvider } from "./Proxy.ts";
import { Queue, QueueProvider } from "./Queue.ts";
import { Sandbox, SandboxProvider } from "./Sandbox.ts";
import { Secret, SecretProvider } from "./Secret.ts";
import { Server, ServerProvider } from "./Server.ts";
import { ServiceUser, ServiceUserProvider } from "./ServiceUser.ts";
import { Volume, VolumeProvider } from "./Volume.ts";
import { WebhookToken, WebhookTokenProvider } from "./WebhookToken.ts";
import { WorkspaceSettings, WorkspaceSettingsProvider } from "./WorkspaceSettings.ts";

/**
 * Service tag bundling every Modal provider + auth + credentials. Use
 * `Modal.providers()` to materialize the full layer.
 */
export class Providers extends Provider.ProviderCollection<Providers>()("Modal") {}

export type ProviderRequirements = Layer.Services<ReturnType<typeof providers>>;

/**
 * Every Modal resource provider, the Modal AuthProvider registration (so
 * `alchemy profile edit` can configure it), and credential resolution.
 *
 * @example
 * ```ts
 * Alchemy.Stack("App", { providers: Modal.providers() }, ...)
 * ```
 */
export const providers = () =>
  Layer.effect(
    Providers,
    Provider.collection([
      App,
      Dict,
      Domain,
      Endpoint,
      Environment,
      Function,
      FunctionAutoscaler,
      Image,
      PersistentSandbox,
      Proxy,
      Queue,
      // Each RPC binding mints its caller's key (`Modal.InvokeFunction`, `Modal.FetchServer`).
      Random,
      Sandbox,
      Secret,
      Server,
      ServiceUser,
      Volume,
      WebhookToken,
      WorkspaceSettings,
    ]),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        AppProvider(),
        DictProvider(),
        DomainProvider(),
        EndpointProvider(),
        EnvironmentProvider(),
        FunctionProvider(),
        FunctionAutoscalerProvider(),
        ImageProvider(),
        PersistentSandboxProvider(),
        ProxyProvider(),
        QueueProvider(),
        RandomProvider(),
        SandboxProvider(),
        SecretProvider(),
        ServerProvider(),
        ServiceUserProvider(),
        VolumeProvider(),
        WebhookTokenProvider(),
        WorkspaceSettingsProvider(),
      ),
    ),
    Layer.provideMerge(Credentials.fromAuthProvider()),
    Layer.provideMerge(FetchHttpClient.layer),
    Layer.provideMerge(ModalAuth),
    Layer.provideMerge(ProfileStoreLive),
    Layer.provideMerge(CredentialsStoreLive),
    Layer.orDie,
  );
