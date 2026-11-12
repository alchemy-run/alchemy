import { CredentialsStoreLive } from "alchemy/Auth/Credentials";
import { ProfileStoreLive } from "alchemy/Auth/Profile";
import * as Provider from "alchemy/Provider";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import { ApiKey, ApiKeyProvider } from "./ApiKeys/ApiKey.ts";
import { ClickHouseCloudAuth } from "./AuthProvider.ts";
import { BackupBucket, BackupBucketProvider } from "./Backup/BackupBucket.ts";
import { BackupConfiguration, BackupConfigurationProvider } from "./Backup/BackupConfiguration.ts";
import { CdcScaling, CdcScalingProvider } from "./ClickPipes/CdcScaling.ts";
import { ClickPipe, ClickPipeProvider } from "./ClickPipes/ClickPipe.ts";
import {
  ReversePrivateEndpoint,
  ReversePrivateEndpointProvider,
} from "./ClickPipes/ReversePrivateEndpoint.ts";
import { WorkloadIdentity, WorkloadIdentityProvider } from "./ClickPipes/WorkloadIdentity.ts";
import { Alert, AlertProvider } from "./ClickStack/Alert.ts";
import { Dashboard, DashboardProvider } from "./ClickStack/Dashboard.ts";
import {
  Role as ClickStackRole,
  RoleProvider as ClickStackRoleProvider,
} from "./ClickStack/Role.ts";
import { SavedSearch, SavedSearchProvider } from "./ClickStack/SavedSearch.ts";
import { Source, SourceProvider } from "./ClickStack/Source.ts";
import { Webhook, WebhookProvider } from "./ClickStack/Webhook.ts";
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
import {
  Service as PostgresService,
  ServiceProvider as PostgresServiceProvider,
} from "./Postgres/Service.ts";
import {
  QueryApiEndpoint,
  QueryApiEndpointProvider,
} from "./QueryApiEndpoints/QueryApiEndpoint.ts";
import { Role, RoleProvider } from "./RoleManagement/Role.ts";
import { SavedQuery, SavedQueryProvider } from "./SavedQueries/SavedQuery.ts";
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
import { Attachment, AttachmentProvider } from "./Udf/Attachment.ts";
import {
  Function as UdfFunction,
  FunctionProvider as UdfFunctionProvider,
} from "./Udf/Function.ts";
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
      Alert,
      ApiKey,
      Attachment,
      BackupBucket,
      BackupConfiguration,
      ByocInfrastructure,
      CdcScaling,
      ClickHouseSetting,
      ClickPipe,
      ClickStackRole,
      Dashboard,
      Invitation,
      JwtProvider,
      Member,
      MemberNotificationSetting,
      Organization,
      PostgresService,
      PreviewFeature,
      PrivateEndpoint,
      QueryApiEndpoint,
      QueryEndpoint,
      ReversePrivateEndpoint,
      Role,
      SavedQuery,
      SavedSearch,
      ScalingSchedule,
      Service,
      SnapshotConfiguration,
      Source,
      UdfFunction,
      UpgradeWindow,
      Webhook,
      WorkloadIdentity,
    ]),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        AlertProvider(),
        ApiKeyProvider(),
        AttachmentProvider(),
        BackupBucketProvider(),
        BackupConfigurationProvider(),
        ByocInfrastructureProvider(),
        CdcScalingProvider(),
        ClickHouseSettingProvider(),
        ClickPipeProvider(),
        ClickStackRoleProvider(),
        DashboardProvider(),
        InvitationProvider(),
        JwtProviderProvider(),
        MemberProvider(),
        MemberNotificationSettingProvider(),
        OrganizationProvider(),
        PostgresServiceProvider(),
        PreviewFeatureProvider(),
        PrivateEndpointProvider(),
        QueryApiEndpointProvider(),
        QueryEndpointProvider(),
        ReversePrivateEndpointProvider(),
        RoleProvider(),
        SavedQueryProvider(),
        SavedSearchProvider(),
        ScalingScheduleProvider(),
        ServiceProvider(),
        SnapshotConfigurationProvider(),
        SourceProvider(),
        UdfFunctionProvider(),
        UpgradeWindowProvider(),
        WebhookProvider(),
        WorkloadIdentityProvider(),
      ),
    ),
    Layer.provideMerge(Credentials.fromAuthProvider()),
    Layer.provideMerge(FetchHttpClient.layer),
    Layer.provideMerge(ClickHouseCloudAuth),
    Layer.provideMerge(ProfileStoreLive),
    Layer.provideMerge(CredentialsStoreLive),
    Layer.orDie,
  );
