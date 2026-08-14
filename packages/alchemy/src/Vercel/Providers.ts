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
import { VercelAuth } from "./AuthProvider.ts";
import { BlobStore, BlobStoreProvider } from "./Blob/BlobStore.ts";
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
  CustomEnvironment,
  CustomEnvironmentProvider,
} from "./Environments/CustomEnvironment.ts";
import { SharedEnv, SharedEnvProvider } from "./Environments/SharedEnv.ts";
import { Function, FunctionProvider } from "./Functions/Function.ts";
import { ProjectEnv, ProjectEnvProvider } from "./Projects/Env.ts";
import { Project, ProjectProvider } from "./Projects/Project.ts";
import {
  RollingRelease,
  RollingReleaseProvider,
} from "./Projects/RollingRelease.ts";
import {
  FirewallConfig,
  FirewallConfigProvider,
} from "./Security/FirewallConfig.ts";
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
    ]),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        ProjectProvider(),
        FunctionProvider(),
        WebhookProvider(),
        DrainProvider(),
        EdgeConfigProvider(),
        EdgeConfigTokenProvider(),
        AccessGroupProvider(),
        AccessGroupProjectProvider(),
        FirewallConfigProvider(),
        DomainProvider(),
        DnsRecordProvider(),
        ProjectDomainProvider(),
        CertProvider(),
        BlobStoreProvider(),
        CustomEnvironmentProvider(),
        SharedEnvProvider(),
        AliasProvider(),
        ProjectEnvProvider(),
        RollingReleaseProvider(),
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
