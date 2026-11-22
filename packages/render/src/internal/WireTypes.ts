import type {
  AutoscalingConfig,
  BlueprintStatus,
  CacheProfile,
  CidrBlockAndDescription,
  DatabaseStatus,
  DedicatedIpStatus,
  DeployStatus,
  LogStreamPreviewSetting,
  LogStreamSetting,
  MaintenanceMode,
  MaxmemoryPolicy,
  NotifyOverride,
  NotifyPreviewOverride,
  NotifySetting,
  NotifySettingV2,
  OpenPortInfo,
  OtelProviderType,
  PersistenceMode,
  PostgresConnectionPool,
  PreviewsGeneration,
  ProtectedStatus,
  Region,
  RegistryType,
  RenderSubdomainPolicy,
  RouteType,
  ServiceType,
  TaskRunStatus,
  WorkflowRuntime,
} from "../Types.ts";

export interface WireOwner {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly type: "team" | "user" | (string & {});
  readonly twoFactorAuthEnabled?: boolean;
  readonly ipAllowList?: CidrBlockAndDescription[];
}

export interface WireOwnerWithCursor {
  readonly cursor?: string;
  readonly owner?: WireOwner;
}

export interface WireProject {
  readonly id: string;
  readonly name: string;
  readonly owner: WireOwner;
  readonly environmentIds: string[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface WireProjectWithCursor {
  readonly cursor: string;
  readonly project: WireProject;
}

export interface WireProjectEnvironmentInput {
  readonly name: string;
  readonly protectedStatus?: ProtectedStatus;
  readonly networkIsolationEnabled?: boolean;
  readonly ipAllowList?: CidrBlockAndDescription[];
}

export interface WireProjectCreateInput {
  readonly name: string;
  readonly ownerId: string;
  readonly environments: WireProjectEnvironmentInput[];
}

export interface WireEnvironment {
  readonly id: string;
  readonly name: string;
  readonly projectId: string;
  readonly protectedStatus: ProtectedStatus;
  readonly networkIsolationEnabled: boolean;
  readonly ipAllowList?: CidrBlockAndDescription[];
  readonly databasesIds?: string[];
  readonly envGroupIds?: string[];
  readonly redisIds?: string[];
  readonly serviceIds?: string[];
}

export interface WireEnvironmentWithCursor {
  readonly cursor: string;
  readonly environment: WireEnvironment;
}

export interface WireEnvironmentCreateInput {
  readonly projectId: string;
  readonly name: string;
  readonly protectedStatus?: ProtectedStatus;
  readonly networkIsolationEnabled?: boolean;
  readonly ipAllowList?: CidrBlockAndDescription[];
}

export interface WireEnvironmentUpdateInput {
  readonly name?: string;
  readonly protectedStatus?: ProtectedStatus;
  readonly networkIsolationEnabled?: boolean;
  readonly ipAllowList?: CidrBlockAndDescription[];
}

export interface WireRegistryCredential {
  readonly id: string;
  readonly name: string;
  readonly registry: RegistryType | (string & {});
  readonly username: string;
  readonly updatedAt: string;
}

export interface WireRegistryCredentialCreateInput {
  readonly name: string;
  readonly ownerId: string;
  readonly registry: RegistryType;
  readonly username: string;
  readonly authToken: string;
}

export interface WireRegistryCredentialUpdateInput {
  readonly name: string;
  readonly registry: RegistryType;
  readonly username: string;
  readonly authToken: string;
}

export interface WireEnvVar {
  readonly key: string;
  readonly value: string;
}

export interface WireEnvVarWithCursor {
  readonly cursor: string;
  readonly envVar: WireEnvVar;
}

export type WireEnvVarInput =
  | { readonly key: string; readonly value: string }
  | { readonly key: string; readonly generateValue: boolean };

export interface WireSecretFile {
  readonly name: string;
  readonly content: string;
}

export interface WireSecretFileWithCursor {
  readonly cursor: string;
  readonly secretFile: WireSecretFile;
}

export interface WireEnvGroupLink {
  readonly id: string;
  readonly name: string;
  readonly type: string;
}

export interface WireEnvGroupMeta {
  readonly id: string;
  readonly name: string;
  readonly ownerId: string;
  readonly environmentId?: string;
  readonly serviceLinks: WireEnvGroupLink[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface WireEnvGroup extends WireEnvGroupMeta {
  readonly envVars: WireEnvVar[];
  readonly secretFiles: WireSecretFile[];
}

export interface WireEnvGroupWithCursor {
  readonly cursor: string;
  readonly envGroup: WireEnvGroupMeta;
}

export interface WireEnvGroupCreateInput {
  readonly name: string;
  readonly ownerId: string;
  readonly environmentId?: string;
  readonly envVars: WireEnvVarInput[];
  readonly secretFiles?: WireSecretFile[];
  readonly serviceIds?: string[];
}

export interface WireDisk {
  readonly id: string;
  readonly name: string;
  readonly mountPath: string;
  readonly sizeGB: number;
}

export interface WireDiskDetails extends WireDisk {
  readonly serviceId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface WireDiskWithCursor {
  readonly cursor?: string;
  readonly disk?: WireDiskDetails;
}

export interface WireBuildFilter {
  readonly paths: string[];
  readonly ignoredPaths: string[];
}

export interface WireNativeEnvironmentDetails {
  readonly buildCommand: string;
  readonly startCommand: string;
  readonly preDeployCommand?: string;
}

export interface WireDockerDetails {
  readonly dockerCommand?: string;
  readonly dockerContext?: string;
  readonly dockerfilePath?: string;
  readonly preDeployCommand?: string;
  readonly registryCredential?: { readonly id: string; readonly name?: string };
}

export interface WireServiceDetails {
  readonly plan?: string;
  readonly region?: Region;
  readonly runtime?: string;
  readonly env?: string;
  readonly buildPlan?: string;
  readonly numInstances?: number;
  readonly autoscaling?: AutoscalingConfig;
  readonly disk?: WireDisk;
  readonly healthCheckPath?: string;
  readonly url?: string;
  readonly openPorts?: OpenPortInfo[];
  readonly sshAddress?: string;
  readonly schedule?: string;
  readonly lastSuccessfulRunAt?: string;
  readonly buildCommand?: string;
  readonly publishPath?: string;
  readonly ipAllowList?: CidrBlockAndDescription[];
  readonly maintenanceMode?: MaintenanceMode;
  readonly maxShutdownDelaySeconds?: number;
  readonly previews?: { readonly generation?: PreviewsGeneration };
  readonly pullRequestPreviewsEnabled?: "yes" | "no";
  readonly renderSubdomainPolicy?: RenderSubdomainPolicy;
  readonly cache?: { readonly profile: CacheProfile };
  readonly envSpecificDetails?: WireNativeEnvironmentDetails | WireDockerDetails;
}

export interface WireService {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly type: ServiceType;
  readonly ownerId: string;
  readonly environmentId?: string;
  readonly repo?: string;
  readonly branch?: string;
  readonly rootDir?: string;
  readonly imagePath?: string;
  readonly autoDeploy: "yes" | "no";
  readonly autoDeployTrigger?: "off" | "commit" | "checksPass";
  readonly buildFilter?: WireBuildFilter;
  readonly registryCredential?: { readonly id: string; readonly name: string };
  readonly dashboardUrl: string;
  readonly notifyOnFail?: NotifySetting;
  readonly suspended: "suspended" | "not_suspended" | (string & {});
  readonly suspenders: string[];
  readonly serviceDetails: WireServiceDetails;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface WireServiceWithCursor {
  readonly cursor: string;
  readonly service: WireService;
}

export interface WireServiceAndDeploy {
  readonly service?: WireService;
  readonly deployId?: string;
}

export interface WireCustomDomain {
  readonly id: string;
  readonly name: string;
  readonly domainType: string;
  readonly publicSuffix: string;
  readonly redirectForName: string;
  readonly verificationStatus: string;
  readonly server?: { readonly id?: string; readonly name?: string };
  readonly createdAt: string;
}

export interface WireCustomDomainWithCursor {
  readonly cursor: string;
  readonly customDomain: WireCustomDomain;
}

export interface WireHeader {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly value: string;
}

export interface WireHeaderWithCursor {
  readonly cursor: string;
  readonly header: WireHeader;
}

export interface WireRoute {
  readonly id: string;
  readonly source: string;
  readonly destination: string;
  readonly type: RouteType;
  readonly priority: number;
}

export interface WireRouteWithCursor {
  readonly cursor: string;
  readonly route: WireRoute;
}

export interface WireDeploy {
  readonly id: string;
  readonly status?: DeployStatus;
  readonly trigger?: string;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
}

export interface WireDeployWithCursor {
  readonly cursor?: string;
  readonly deploy?: WireDeploy;
}

export interface WirePostgresReadReplica {
  readonly id: string;
  readonly name: string;
  readonly parameterOverrides?: Record<string, string>;
}

export interface WirePostgres {
  readonly id: string;
  readonly name: string;
  readonly owner: WireOwner;
  readonly plan: string;
  readonly region: Region;
  readonly version: string;
  readonly databaseName: string;
  readonly databaseUser: string;
  readonly diskSizeGB?: number;
  readonly diskAutoscalingEnabled: boolean;
  readonly highAvailabilityEnabled: boolean;
  readonly environmentId?: string;
  readonly ipAllowList: CidrBlockAndDescription[];
  readonly readReplicas: WirePostgresReadReplica[];
  readonly parameterOverrides?: Record<string, string>;
  readonly connectionPool?: PostgresConnectionPool;
  readonly primaryPostgresID?: string;
  readonly role: string;
  readonly status: DatabaseStatus;
  readonly suspended: string;
  readonly suspenders: string[];
  readonly dashboardUrl: string;
  readonly expiresAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface WirePostgresWithCursor {
  readonly cursor: string;
  readonly postgres: WirePostgres;
}

export interface WirePostgresConnectionInfo {
  readonly externalConnectionString: string;
  readonly internalConnectionString: string;
  readonly password: string;
  readonly psqlCommand: string;
}

export interface WireKeyValue {
  readonly id: string;
  readonly name: string;
  readonly owner: WireOwner;
  readonly plan: string;
  readonly region: Region;
  readonly version: string;
  readonly environmentId?: string;
  readonly ipAllowList: CidrBlockAndDescription[];
  readonly options: {
    readonly maxmemoryPolicy?: MaxmemoryPolicy | (string & {});
    readonly persistenceMode?: PersistenceMode | (string & {});
  };
  readonly status: DatabaseStatus;
  readonly dashboardUrl?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface WireKeyValueWithCursor {
  readonly cursor: string;
  readonly keyValue: WireKeyValue;
}

export interface WireKeyValueConnectionInfo {
  readonly cliCommand: string;
  readonly externalConnectionString: string;
  readonly internalConnectionString: string;
}

export interface WireRedis {
  readonly id: string;
  readonly name: string;
  readonly owner: WireOwner;
  readonly plan: string;
  readonly region: Region;
  readonly version: string;
  readonly environmentId?: string;
  readonly ipAllowList: CidrBlockAndDescription[];
  readonly options: {
    readonly maxmemoryPolicy?: MaxmemoryPolicy | (string & {});
    readonly persistenceMode?: PersistenceMode | (string & {});
  };
  readonly status: DatabaseStatus;
  readonly dashboardUrl?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface WireRedisWithCursor {
  readonly cursor: string;
  readonly redis: WireRedis;
}

export interface WireRedisConnectionInfo {
  readonly redisCLICommand: string;
  readonly externalConnectionString: string;
  readonly internalConnectionString: string;
}

export interface WireWebhook {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly enabled: boolean;
  readonly eventFilter: string[];
  readonly secret: string;
}

export interface WireWebhookWithCursor {
  readonly cursor: string;
  readonly webhook: WireWebhook;
}

export interface WireDedicatedIp {
  readonly id: string;
  readonly name: string;
  readonly ownerId: string;
  readonly region: Region;
  readonly description: string;
  readonly environmentIds: string[];
  readonly ips: string[];
  readonly status: DedicatedIpStatus;
  readonly createdAt: string;
  readonly updatedAt?: string;
}

export interface WireOwnerLogStreamSetting {
  readonly ownerId?: string;
  readonly endpoint?: string;
  readonly preview?: LogStreamPreviewSetting;
}

export interface WireResourceLogStreamSetting {
  readonly resourceId?: string;
  readonly endpoint?: string;
  readonly setting?: LogStreamSetting;
}

export interface WireMetricsStream {
  readonly ownerId: string;
  readonly provider: OtelProviderType;
  readonly url: string;
}

export interface WireNotificationSetting {
  readonly ownerId: string;
  readonly emailEnabled: boolean;
  readonly slackEnabled: boolean;
  readonly notificationsToSend: NotifySettingV2;
  readonly previewNotificationsEnabled: boolean;
}

export interface WireNotificationOverride {
  readonly serviceId: string;
  readonly notificationsToSend: NotifyOverride;
  readonly previewNotificationsEnabled: NotifyPreviewOverride;
}

export interface WirePostgresRecoveryInfo {
  readonly recoveryStatus: string;
  readonly startsAt?: string;
}

export interface WirePostgresExport {
  readonly id: string;
  readonly url?: string;
  readonly createdAt?: string;
}

export interface WireWorkflowBuildConfig {
  readonly runtime?: WorkflowRuntime;
  readonly repo?: string;
  readonly branch?: string;
  readonly rootDir?: string;
  readonly buildCommand?: string;
}

export interface WireWorkflow {
  readonly id: string;
  readonly name: string;
  readonly slug?: string;
  readonly ownerId: string;
  readonly environmentId?: string;
  readonly region: Region;
  readonly runtime?: WorkflowRuntime;
  readonly repo?: string;
  readonly branch?: string;
  readonly rootDir?: string;
  readonly buildCommand?: string;
  readonly runCommand: string;
  readonly buildConfig?: WireWorkflowBuildConfig;
  readonly autoDeployTrigger?: "off" | "commit" | "checksPass";
  readonly defaultVersionId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface WireWorkflowWithCursor {
  readonly cursor?: string;
  readonly workflow?: WireWorkflow;
}

export interface WireWorkflowVersion {
  readonly id: string;
  readonly workflowId: string;
  readonly name?: string;
  readonly status?: string;
  readonly createdAt?: string;
  readonly updatedAt?: string;
}

export interface WireWorkflowVersionWithCursor {
  readonly cursor?: string;
  readonly workflowVersion?: WireWorkflowVersion;
}

export interface WireTaskRun {
  readonly id: string;
  readonly task: string;
  readonly status: TaskRunStatus;
  readonly input?: unknown;
  readonly results?: unknown;
  readonly output?: unknown;
  readonly error?: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly finishedAt?: string;
  readonly createdAt?: string;
  readonly updatedAt?: string;
}

export interface WireTaskRunWithCursor {
  readonly cursor?: string;
  readonly taskRun?: WireTaskRun;
}

export interface WireBlueprint {
  readonly id: string;
  readonly name: string;
  readonly ownerId: string;
  readonly repo: string;
  readonly branch: string;
  readonly path: string;
  readonly status: BlueprintStatus;
  readonly autoSync: boolean;
  readonly lastSync?: string;
}

export interface WireBlueprintWithCursor {
  readonly cursor?: string;
  readonly blueprint?: WireBlueprint;
}

export interface WireBlueprintResource {
  readonly id: string;
  readonly name: string;
  readonly type: string;
}

export interface WireBlueprintDetail extends WireBlueprint {
  readonly resources?: ReadonlyArray<WireBlueprintResource>;
}

export interface WireBlueprintSyncCommit {
  readonly id?: string;
  readonly message?: string;
  readonly url?: string;
}

export interface WireBlueprintSync {
  readonly id: string;
  readonly state: string;
  readonly commit?: WireBlueprintSyncCommit;
  readonly startedAt?: string;
  readonly completedAt?: string;
}

export interface WireBlueprintSyncWithCursor {
  readonly cursor?: string;
  readonly sync?: WireBlueprintSync;
}

export interface WireBlueprintValidateResponse {
  readonly valid?: boolean;
  readonly error?: string;
  readonly plan?: unknown;
}

export interface WireLogLabel {
  readonly name: string;
  readonly value?: string;
}

export interface WireLogEntry {
  readonly id: string;
  readonly timestamp: string;
  readonly message: string;
  readonly labels?: ReadonlyArray<WireLogLabel>;
}

export interface WireLogsResponse {
  readonly hasMore: boolean;
  readonly nextStartTime?: string;
  readonly nextEndTime?: string;
  readonly logs: ReadonlyArray<WireLogEntry>;
}
