import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { CredentialsStoreLive } from "../Auth/Credentials.ts";
import { ProfileLive } from "../Auth/Profile.ts";
import * as Command from "../Command/index.ts";
import * as Provider from "../Provider.ts";
import {
  AccessGroup,
  AccessGroupProvider,
} from "./AccessGroups/AccessGroup.ts";
import {
  AccessGroupProject,
  AccessGroupProjectProvider,
} from "./AccessGroups/AccessGroupProject.ts";
import { Alias, AliasProvider } from "./Aliases/Alias.ts";
import {
  WebAnalytics,
  WebAnalyticsProvider,
} from "./Analytics/WebAnalytics.ts";
import { VercelAuth } from "./AuthProvider.ts";
import { BlobStore, BlobStoreProvider } from "./Blob/BlobStore.ts";
import { LocalBlobStoreProvider } from "./Blob/LocalBlobStoreProvider.ts";
import { Check, CheckProvider } from "./Checks/Check.ts";
import * as Credentials from "./Credentials.ts";
import { Cert, CertProvider } from "./Domains/Cert.ts";
import { DnsRecord, DnsRecordProvider } from "./Domains/DnsRecord.ts";
import { Domain, DomainProvider } from "./Domains/Domain.ts";
import {
  ProjectDomain,
  ProjectDomainProvider,
} from "./Domains/ProjectDomain.ts";
import { Drain, DrainProvider } from "./Drains/Drain.ts";
import { EdgeConfig, EdgeConfigProvider } from "./EdgeConfig/EdgeConfig.ts";
import {
  EdgeConfigToken,
  EdgeConfigTokenProvider,
} from "./EdgeConfig/EdgeConfigToken.ts";
import {
  LocalEdgeConfigProvider,
  LocalEdgeConfigTokenProvider,
} from "./EdgeConfig/LocalEdgeConfigProvider.ts";
import {
  CustomEnvironment,
  CustomEnvironmentProvider,
} from "./Environments/CustomEnvironment.ts";
import { SharedEnv, SharedEnvProvider } from "./Environments/SharedEnv.ts";
import {
  FeatureFlag,
  FeatureFlagProvider,
} from "./FeatureFlags/FeatureFlag.ts";
import * as ProviderLayer from "../Local/ProviderLayer.ts";
import { Function, FunctionProvider } from "./Functions/Function.ts";
import { LocalFunctionProvider } from "./Functions/LocalFunctionProvider.ts";
import { localVercelServices } from "./LocalRuntime.ts";
import {
  MicrofrontendsGroup,
  MicrofrontendsGroupProvider,
} from "./Microfrontends/MicrofrontendsGroup.ts";
import {
  ProjectMember,
  ProjectMemberProvider,
} from "./ProjectMembers/ProjectMember.ts";
import { ProjectEnv, ProjectEnvProvider } from "./Projects/Env.ts";
import { Project, ProjectProvider } from "./Projects/Project.ts";
import {
  RollingRelease,
  RollingReleaseProvider,
} from "./Projects/RollingRelease.ts";
import {
  BulkRedirects,
  BulkRedirectsProvider,
} from "./Routes/BulkRedirects.ts";
import {
  ProjectRoutes,
  ProjectRoutesProvider,
} from "./Routes/ProjectRoutes.ts";
import {
  SandboxDrive,
  SandboxDriveProvider,
} from "./Sandboxes/SandboxDrive.ts";
import {
  SandboxSnapshot,
  SandboxSnapshotProvider,
} from "./Sandboxes/SandboxSnapshot.ts";
import {
  FirewallConfig,
  FirewallConfigProvider,
} from "./Security/FirewallConfig.ts";
import { Team, TeamProvider } from "./Teams/Team.ts";
import { TeamMember, TeamMemberProvider } from "./Teams/TeamMember.ts";
import * as VercelEnvironment from "./VercelEnvironment.ts";
import { Webhook, WebhookProvider } from "./Webhooks/Webhook.ts";

export class Providers extends Provider.ProviderCollection<Providers>()(
  "Vercel",
) {}

/**
 * Build a layer that registers all Vercel resource providers, the Vercel
 * `AuthProvider`, the resolved `Credentials`, the `VercelEnvironment`
 * (team scope), and an `HttpClient`. Include this from your stack alongside
 * other cloud `providers()` layers.
 *
 * @example
 * ```typescript
 * import * as Alchemy from "alchemy";
 * import * as Vercel from "alchemy/Vercel";
 * import * as Effect from "effect/Effect";
 *
 * export default Alchemy.Stack(
 *   "MyStack",
 *   {
 *     providers: Vercel.providers(),
 *     state: Alchemy.localState(),
 *   },
 *   Effect.gen(function* () {
 *     return {};
 *   }),
 * );
 * ```
 */
/**
 * The Vercel API foundation every effect tree that talks to the Vercel
 * management API shares — credentials resolved through the Alchemy auth
 * provider, team environment, profile + credential store, and an HTTP
 * client. Used by {@link providers} consumers and the Vercel state store
 * ({@link ./StateStore/State.ts state}) so out-of-band probes run with
 * the same wiring as provider lifecycle operations.
 */
export const VercelApiLive = () =>
  Credentials.fromAuthProvider().pipe(
    Layer.provideMerge(VercelEnvironment.fromProfile()),
    Layer.provideMerge(VercelAuth),
    Layer.provideMerge(ProfileLive),
    Layer.provideMerge(CredentialsStoreLive),
    Layer.provideMerge(FetchHttpClient.layer),
  );

export const providers = () =>
  Layer.effect(
    Providers,
    Provider.collection([
      Project,
      Function,
      Webhook,
      Drain,
      EdgeConfig,
      EdgeConfigToken,
      AccessGroup,
      AccessGroupProject,
      FirewallConfig,
      Domain,
      DnsRecord,
      ProjectDomain,
      Cert,
      BlobStore,
      CustomEnvironment,
      SharedEnv,
      Alias,
      ProjectEnv,
      RollingRelease,
      ProjectMember,
      ProjectRoutes,
      BulkRedirects,
      FeatureFlag,
      MicrofrontendsGroup,
      Check,
      Team,
      TeamMember,
      WebAnalytics,
      SandboxDrive,
      SandboxSnapshot,
    ]),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        ProjectProvider(),
        // Function registers BOTH provider modes: live deploys, local (dev)
        // emulates via a dev-server child. Mode-specific deps compose
        // inside the local thunk (built lazily — a plain deploy never
        // constructs local machinery unless a local-mode row needs it).
        ProviderLayer.dual(Function, {
          live: () => FunctionProvider(),
          local: () =>
            LocalFunctionProvider().pipe(Layer.provide(localVercelServices())),
        }),
        WebhookProvider(),
        DrainProvider(),
        // EdgeConfig(+Token) register BOTH provider modes: live converges
        // the real config, local (dev) seeds an in-memory registry served
        // by a sidecar data-plane endpoint. The local token provider still
        // delegates to the live lifecycle for `Alchemy.remote()` configs.
        ProviderLayer.dual(EdgeConfig, {
          live: () => EdgeConfigProvider(),
          local: () =>
            LocalEdgeConfigProvider().pipe(
              Layer.provide(localVercelServices()),
            ),
        }),
        ProviderLayer.dual(EdgeConfigToken, {
          live: () => EdgeConfigTokenProvider(),
          local: () =>
            LocalEdgeConfigTokenProvider().pipe(
              Layer.provide(localVercelServices()),
            ),
        }),
        AccessGroupProvider(),
        AccessGroupProjectProvider(),
        FirewallConfigProvider(),
        DomainProvider(),
        DnsRecordProvider(),
        ProjectDomainProvider(),
        CertProvider(),
        // BlobStore registers BOTH provider modes: live creates the store on
        // Vercel, local (dev) emulates the data plane in the sidecar.
        ProviderLayer.dual(BlobStore, {
          live: () => BlobStoreProvider(),
          local: () =>
            LocalBlobStoreProvider().pipe(Layer.provide(localVercelServices())),
        }),
        CustomEnvironmentProvider(),
        SharedEnvProvider(),
        AliasProvider(),
        ProjectEnvProvider(),
        RollingReleaseProvider(),
        ProjectMemberProvider(),
        ProjectRoutesProvider(),
        BulkRedirectsProvider(),
        FeatureFlagProvider(),
        MicrofrontendsGroupProvider(),
        CheckProvider(),
        TeamProvider(),
        TeamMemberProvider(),
        WebAnalyticsProvider(),
        SandboxDriveProvider(),
        SandboxSnapshotProvider(),
      ),
    ),
    // `Website.*` transformers declare `Command.Build` resources (the
    // framework/static builds) — their providers ride along, mirroring
    // Cloudflare's barrel.
    Layer.provideMerge(Command.providers()),
    Layer.provideMerge(Credentials.fromAuthProvider()),
    Layer.provideMerge(VercelEnvironment.fromProfile()),
    Layer.provideMerge(VercelAuth),
    Layer.provideMerge(ProfileLive),
    Layer.provideMerge(CredentialsStoreLive),
    Layer.provideMerge(FetchHttpClient.layer),
    Layer.orDie,
  );
