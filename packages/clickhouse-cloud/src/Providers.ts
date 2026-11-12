import { CredentialsStoreLive } from "alchemy/Auth/Credentials";
import { ProfileStoreLive } from "alchemy/Auth/Profile";
import * as Provider from "alchemy/Provider";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import { ApiKey, ApiKeyProvider } from "./ApiKeys/ApiKey.ts";
import { ClickHouseCloudAuth } from "./AuthProvider.ts";
import { BackupBucket, BackupBucketProvider } from "./Backup/BackupBucket.ts";
import { BackupConfiguration, BackupConfigurationProvider } from "./Backup/BackupConfiguration.ts";
import * as Credentials from "./Credentials.ts";
import {
  MemberNotificationSetting,
  MemberNotificationSettingProvider,
} from "./Notifications/MemberNotificationSetting.ts";
import {
  ByocInfrastructure,
  ByocInfrastructureProvider,
} from "./Organization/ByocInfrastructure.ts";
import { Organization, OrganizationProvider } from "./Organization/Organization.ts";
import { PreviewFeature, PreviewFeatureProvider } from "./Organization/PreviewFeature.ts";
import { Role, RoleProvider } from "./RoleManagement/Role.ts";
import { ClickHouseSetting, ClickHouseSettingProvider } from "./Service/ClickHouseSetting.ts";
import { JwtProvider, JwtProviderProvider } from "./Service/JwtProvider.ts";
import { PrivateEndpoint, PrivateEndpointProvider } from "./Service/PrivateEndpoint.ts";
import { QueryEndpoint, QueryEndpointProvider } from "./Service/QueryEndpoint.ts";
import { ScalingSchedule, ScalingScheduleProvider } from "./Service/ScalingSchedule.ts";
import { Service, ServiceProvider } from "./Service/Service.ts";
import { UpgradeWindow, UpgradeWindowProvider } from "./Service/UpgradeWindow.ts";
import {
  SnapshotConfiguration,
  SnapshotConfigurationProvider,
} from "./Snapshot/SnapshotConfiguration.ts";
import { Invitation, InvitationProvider } from "./UserManagement/Invitation.ts";
import { Member, MemberProvider } from "./UserManagement/Member.ts";

/**
 * Service tag bundling all ClickHouse Cloud providers + auth + credentials.
 * Use `ClickHouseCloud.providers()` to materialize the full layer.
 */
export class Providers extends Provider.ProviderCollection<Providers>()("ClickHouseCloud") {}

export type ProviderRequirements = Layer.Services<ReturnType<typeof providers>>;

/**
 * Build the complete ClickHouse Cloud providers Layer: every resource, the
 * AuthProvider registration (so `alchemy profile edit` can configure it),
 * and credential resolution.
 *
 * @example
 * ```ts
 * Alchemy.Stack("App", { providers: ClickHouseCloud.providers() }, ...)
 * ```
 */
export const providers = () =>
  Layer.effect(
    Providers,
    Provider.collection([
      ApiKey,
      BackupBucket,
      BackupConfiguration,
      ByocInfrastructure,
      ClickHouseSetting,
      Invitation,
      JwtProvider,
      Member,
      MemberNotificationSetting,
      Organization,
      PreviewFeature,
      PrivateEndpoint,
      QueryEndpoint,
      Role,
      ScalingSchedule,
      Service,
      SnapshotConfiguration,
      UpgradeWindow,
    ]),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        ApiKeyProvider(),
        BackupBucketProvider(),
        BackupConfigurationProvider(),
        ByocInfrastructureProvider(),
        ClickHouseSettingProvider(),
        InvitationProvider(),
        JwtProviderProvider(),
        MemberProvider(),
        MemberNotificationSettingProvider(),
        OrganizationProvider(),
        PreviewFeatureProvider(),
        PrivateEndpointProvider(),
        QueryEndpointProvider(),
        RoleProvider(),
        ScalingScheduleProvider(),
        ServiceProvider(),
        SnapshotConfigurationProvider(),
        UpgradeWindowProvider(),
      ),
    ),
    Layer.provideMerge(Credentials.fromAuthProvider()),
    Layer.provideMerge(FetchHttpClient.layer),
    Layer.provideMerge(ClickHouseCloudAuth),
    Layer.provideMerge(ProfileStoreLive),
    Layer.provideMerge(CredentialsStoreLive),
    Layer.orDie,
  );
