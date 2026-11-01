import { CredentialsStoreLive } from "alchemy/Auth/Credentials";
import { ProfileStoreLive } from "alchemy/Auth/Profile";
import * as Command from "alchemy/Command";
import * as Provider from "alchemy/Provider";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import { ConvexAuth } from "./AuthProvider.ts";
import * as Credentials from "./Credentials.ts";
import { DeployKey, DeployKeyProvider } from "./DeployKey.ts";
import { Deployment, DeploymentProvider } from "./Deployment.ts";
import { EnvironmentVariables, EnvironmentVariablesProvider } from "./EnvironmentVariables.ts";
import { PreviewDeployKey, PreviewDeployKeyProvider } from "./PreviewDeployKey.ts";
import { Project, ProjectProvider } from "./Project.ts";

/**
 * Service tag bundling all Convex providers, auth and credentials. Use
 * `Convex.providers()` to materialize the full layer.
 */
export class Providers extends Provider.ProviderCollection<Providers>()("Convex") {}

export type ProviderRequirements = Layer.Services<ReturnType<typeof providers>>;

/**
 * Build the complete Convex providers Layer: every Convex resource, the
 * Convex AuthProvider registration (so `alchemy profile edit` can configure
 * it), and credential resolution.
 *
 * @example
 * ```ts
 * Alchemy.Stack("App", { providers: Convex.providers() }, ...)
 * ```
 */
export const providers = () =>
  Layer.effect(
    Providers,
    Provider.collection([Deployment, DeployKey, EnvironmentVariables, PreviewDeployKey, Project]),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        DeploymentProvider(),
        DeployKeyProvider(),
        EnvironmentVariablesProvider(),
        PreviewDeployKeyProvider(),
        ProjectProvider(),
      ),
    ),
    Layer.provideMerge(Command.providers()),
    Layer.provideMerge(Credentials.fromAuthProvider()),
    Layer.provideMerge(FetchHttpClient.layer),
    Layer.provideMerge(ConvexAuth),
    Layer.provideMerge(ProfileStoreLive),
    Layer.provideMerge(CredentialsStoreLive),
    Layer.orDie,
  );
