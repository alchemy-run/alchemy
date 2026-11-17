import { DockerLive } from "@alchemy.run/docker/Docker";
import { CredentialsStoreLive } from "alchemy/Auth/Credentials";
import { ProfileStoreLive } from "alchemy/Auth/Profile";
import * as Provider from "alchemy/Provider";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import { ApiKey, ApiKeyProvider } from "./ApiKey.ts";
import { DaytonaAuth } from "./AuthProvider.ts";
import * as Credentials from "./Credentials.ts";
import { IdentityProvider, IdentityProviderProvider } from "./IdentityProvider.ts";
import { Organization, OrganizationProvider } from "./Organization.ts";
import {
  OrganizationInvitation,
  OrganizationInvitationProvider,
} from "./OrganizationInvitation.ts";
import { OrganizationMember, OrganizationMemberProvider } from "./OrganizationMember.ts";
import {
  OrganizationOtelConfig,
  OrganizationOtelConfigProvider,
} from "./OrganizationOtelConfig.ts";
import { OrganizationRole, OrganizationRoleProvider } from "./OrganizationRole.ts";
import { OrganizationSettings, OrganizationSettingsProvider } from "./OrganizationSettings.ts";
import { Region, RegionProvider } from "./Region.ts";
import { Registry, RegistryProvider } from "./Registry.ts";
import { Runner, RunnerProvider } from "./Runner.ts";
import { Sandbox, SandboxProvider } from "./Sandbox.ts";
import { Secret, SecretProvider } from "./Secret.ts";
import { Snapshot, SnapshotProvider } from "./Snapshot.ts";
import { Volume, VolumeProvider } from "./Volume.ts";
import { WarmPool, WarmPoolProvider } from "./WarmPool.ts";
import { Webhooks, WebhooksProvider } from "./Webhooks.ts";

export class Providers extends Provider.ProviderCollection<Providers>()("Daytona") {}

export type ProviderRequirements = Layer.Services<ReturnType<typeof providers>>;

/**
 * Daytona providers and credentials: every Daytona resource, and the
 * Daytona AuthProvider so `alchemy profile edit` can configure it.
 */
export const providers = () =>
  Layer.effect(
    Providers,
    Provider.collection([
      ApiKey,
      IdentityProvider,
      Organization,
      OrganizationInvitation,
      OrganizationMember,
      OrganizationOtelConfig,
      OrganizationRole,
      OrganizationSettings,
      Region,
      Registry,
      Runner,
      Sandbox,
      Secret,
      Snapshot,
      Volume,
      WarmPool,
      Webhooks,
    ]),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        ApiKeyProvider(),
        IdentityProviderProvider(),
        OrganizationProvider(),
        OrganizationInvitationProvider(),
        OrganizationMemberProvider(),
        OrganizationOtelConfigProvider(),
        OrganizationRoleProvider(),
        OrganizationSettingsProvider(),
        RegionProvider(),
        RegistryProvider(),
        RunnerProvider(),
        SandboxProvider(),
        SecretProvider(),
        SnapshotProvider(),
        VolumeProvider(),
        WarmPoolProvider(),
        WebhooksProvider(),
      ),
    ),
    // Snapshots Daytona can't build are built with local Docker.
    Layer.provideMerge(DockerLive),
    Layer.provideMerge(Credentials.fromAuthProvider()),
    Layer.provideMerge(FetchHttpClient.layer),
    Layer.provideMerge(DaytonaAuth),
    Layer.provideMerge(ProfileStoreLive),
    Layer.provideMerge(CredentialsStoreLive),
    Layer.orDie,
  );
