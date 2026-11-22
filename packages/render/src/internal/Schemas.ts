import * as Schema from "effect/Schema";
import * as SchemaGetter from "effect/SchemaGetter";
import type {
  AutoscalingCriteriaPercentage,
  BlueprintStatus,
  CacheProfile,
  DatabaseStatus,
  DedicatedIpStatus,
  DeployStatus,
  LogStreamPreviewSetting,
  LogStreamSetting,
  MaxmemoryPolicy,
  NotifyOverride,
  NotifyPreviewOverride,
  NotifySetting,
  NotifySettingV2,
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
import type {
  WireBlueprint,
  WireBlueprintDetail,
  WireBlueprintSyncWithCursor,
  WireBlueprintValidateResponse,
  WireBlueprintWithCursor,
  WireCustomDomain,
  WireCustomDomainWithCursor,
  WireDedicatedIp,
  WireDeploy,
  WireDeployWithCursor,
  WireDiskDetails,
  WireDiskWithCursor,
  WireEnvGroup,
  WireEnvGroupMeta,
  WireEnvGroupWithCursor,
  WireEnvVar,
  WireEnvVarWithCursor,
  WireEnvironment,
  WireEnvironmentWithCursor,
  WireHeader,
  WireHeaderWithCursor,
  WireKeyValue,
  WireKeyValueConnectionInfo,
  WireKeyValueWithCursor,
  WireLogEntry,
  WireLogsResponse,
  WireMetricsStream,
  WireNotificationOverride,
  WireNotificationSetting,
  WireOwner,
  WireOwnerLogStreamSetting,
  WireOwnerWithCursor,
  WirePostgres,
  WirePostgresConnectionInfo,
  WirePostgresExport,
  WirePostgresRecoveryInfo,
  WirePostgresWithCursor,
  WireProject,
  WireProjectWithCursor,
  WireRedis,
  WireRedisConnectionInfo,
  WireRedisWithCursor,
  WireRegistryCredential,
  WireResourceLogStreamSetting,
  WireRoute,
  WireRouteWithCursor,
  WireSecretFile,
  WireSecretFileWithCursor,
  WireService,
  WireServiceAndDeploy,
  WireServiceDetails,
  WireServiceWithCursor,
  WireTaskRun,
  WireTaskRunWithCursor,
  WireWebhook,
  WireWebhookWithCursor,
  WireWorkflow,
  WireWorkflowVersion,
  WireWorkflowVersionWithCursor,
  WireWorkflowWithCursor,
} from "./WireTypes.ts";

/** Optional property that also normalizes wire `null` values to `undefined`. */
const opt = <T>(schema: Schema.Codec<T, unknown, never, never>) =>
  schema.pipe(
    Schema.NullOr,
    Schema.decodeTo(Schema.UndefinedOr(schema), {
      decode: SchemaGetter.transform((v) => (v === null ? undefined : v)),
      encode: SchemaGetter.forbiddenEncoding,
    }),
    Schema.optional,
  );

/** Mutable array property that normalizes omitted or `null` wire arrays to `[]`. */
const defaultArray = <T>(item: Schema.Codec<T, unknown, never, never>) =>
  item.pipe(
    Schema.Array,
    Schema.NullOr,
    Schema.optional,
    Schema.decodeTo(item.pipe(Schema.Array, Schema.mutable), {
      decode: SchemaGetter.transform((v) => (Array.isArray(v) ? [...v] : [])),
      encode: SchemaGetter.forbiddenEncoding,
    }),
  );

/** Optional mutable array property normalizing `null` to `undefined`. */
const optArray = <T>(item: Schema.Codec<T, unknown, never, never>) =>
  item.pipe(Schema.Array, Schema.mutable, opt);

/** String property that normalizes `null` or omitted cursor values to `""`. */
const defaultString = Schema.String.pipe(
  Schema.NullOr,
  Schema.optional,
  Schema.decodeTo(Schema.String, {
    decode: SchemaGetter.transform((v) => v ?? ""),
    encode: SchemaGetter.forbiddenEncoding,
  }),
);

/** Boolean property that normalizes `null` or omitted values to `false`. */
const defaultBoolean = Schema.Boolean.pipe(
  Schema.NullOr,
  Schema.optional,
  Schema.decodeTo(Schema.Boolean, {
    decode: SchemaGetter.transform((v) => v === true),
    encode: SchemaGetter.forbiddenEncoding,
  }),
);

/** Open string enum schema preserving literal + `(string & {})` TypeScript types. */
const openEnum = <T extends string>() => Schema.declare<T>((u): u is T => typeof u === "string");

/** Array decoder that treats Render's occasional `200 null` empty list as `[]`. */
export const nullableArray = <T>(item: Schema.Decoder<T>) =>
  item.pipe(
    Schema.Array,
    Schema.NullOr,
    Schema.decodeTo(item.pipe(Schema.Array, Schema.mutable), {
      decode: SchemaGetter.transform((v) => (Array.isArray(v) ? [...v] : [])),
      encode: SchemaGetter.forbiddenEncoding,
    }),
  );

export const VoidResponseSchema: Schema.Decoder<void> = Schema.Unknown.pipe(
  Schema.decodeTo(Schema.Void, {
    decode: SchemaGetter.transform(() => undefined),
    encode: SchemaGetter.forbiddenEncoding,
  }),
);

const CidrBlockAndDescriptionSchema = Schema.Struct({
  cidrBlock: Schema.String,
  description: defaultString,
});

export const WireOwnerSchema: Schema.Codec<WireOwner, unknown, never, never> = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  email: defaultString,
  type: openEnum<WireOwner["type"]>(),
  twoFactorAuthEnabled: opt(Schema.Boolean),
  ipAllowList: optArray(CidrBlockAndDescriptionSchema),
});

export const WireOwnerWithCursorSchema: Schema.Decoder<WireOwnerWithCursor> = Schema.Struct({
  cursor: opt(Schema.String),
  owner: opt(WireOwnerSchema),
});

export const WireProjectSchema: Schema.Codec<WireProject, unknown, never, never> = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  owner: WireOwnerSchema,
  environmentIds: defaultArray(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});

export const WireProjectWithCursorSchema: Schema.Decoder<WireProjectWithCursor> = Schema.Struct({
  cursor: defaultString,
  project: WireProjectSchema,
});

export const WireEnvironmentSchema: Schema.Codec<WireEnvironment, unknown, never, never> =
  Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    projectId: Schema.String,
    protectedStatus: Schema.Literals([
      "protected",
      "unprotected",
    ] satisfies ReadonlyArray<ProtectedStatus>),
    networkIsolationEnabled: defaultBoolean,
    ipAllowList: optArray(CidrBlockAndDescriptionSchema),
    databasesIds: optArray(Schema.String),
    envGroupIds: optArray(Schema.String),
    redisIds: optArray(Schema.String),
    serviceIds: optArray(Schema.String),
  });

export const WireEnvironmentWithCursorSchema: Schema.Decoder<WireEnvironmentWithCursor> =
  Schema.Struct({
    cursor: defaultString,
    environment: WireEnvironmentSchema,
  });

export const WireRegistryCredentialSchema: Schema.Codec<
  WireRegistryCredential,
  unknown,
  never,
  never
> = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  registry: openEnum<RegistryType | (string & {})>(),
  username: Schema.String,
  updatedAt: Schema.String,
});

export const WireRegistryCredentialListSchema: Schema.Decoder<WireRegistryCredential[]> =
  nullableArray(WireRegistryCredentialSchema);

export const WireEnvVarSchema: Schema.Codec<WireEnvVar, unknown, never, never> = Schema.Struct({
  key: Schema.String,
  value: Schema.String,
});

export const WireEnvVarWithCursorSchema: Schema.Decoder<WireEnvVarWithCursor> = Schema.Struct({
  cursor: defaultString,
  envVar: WireEnvVarSchema,
});

export const WireEnvVarWithCursorListSchema: Schema.Decoder<WireEnvVarWithCursor[]> = nullableArray(
  WireEnvVarWithCursorSchema,
);

export const WireSecretFileSchema: Schema.Codec<WireSecretFile, unknown, never, never> =
  Schema.Struct({
    name: Schema.String,
    content: Schema.String,
  });

export const WireSecretFileWithCursorSchema: Schema.Decoder<WireSecretFileWithCursor> =
  Schema.Struct({
    cursor: defaultString,
    secretFile: WireSecretFileSchema,
  });

export const WireSecretFileWithCursorListSchema: Schema.Decoder<WireSecretFileWithCursor[]> =
  nullableArray(WireSecretFileWithCursorSchema);

const WireEnvGroupLinkSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  type: Schema.String,
});

export const WireEnvGroupMetaSchema: Schema.Codec<WireEnvGroupMeta, unknown, never, never> =
  Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    ownerId: Schema.String,
    environmentId: opt(Schema.String),
    serviceLinks: defaultArray(WireEnvGroupLinkSchema),
    createdAt: Schema.String,
    updatedAt: Schema.String,
  });

export const WireEnvGroupWithCursorSchema: Schema.Decoder<WireEnvGroupWithCursor> = Schema.Struct({
  cursor: defaultString,
  envGroup: WireEnvGroupMetaSchema,
});

export const WireEnvGroupSchema: Schema.Decoder<WireEnvGroup> = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  ownerId: Schema.String,
  environmentId: opt(Schema.String),
  serviceLinks: defaultArray(WireEnvGroupLinkSchema),
  envVars: defaultArray(WireEnvVarSchema),
  secretFiles: defaultArray(WireSecretFileSchema),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});

const AutoscalingCriteriaPercentageSchema: Schema.Codec<
  AutoscalingCriteriaPercentage,
  unknown,
  never,
  never
> = Schema.Struct({
  enabled: Schema.Boolean,
  percentage: Schema.Number,
});

const AutoscalingConfigSchema = Schema.Struct({
  enabled: Schema.Boolean,
  min: Schema.Number,
  max: Schema.Number,
  criteria: Schema.Struct({
    cpu: AutoscalingCriteriaPercentageSchema,
    memory: AutoscalingCriteriaPercentageSchema,
  }),
});

export const WireDiskDetailsSchema: Schema.Codec<WireDiskDetails, unknown, never, never> =
  Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    mountPath: Schema.String,
    sizeGB: Schema.Number,
    serviceId: opt(Schema.String),
    createdAt: Schema.String,
    updatedAt: Schema.String,
  });

export const WireDiskWithCursorSchema: Schema.Decoder<WireDiskWithCursor> = Schema.Struct({
  cursor: opt(Schema.String),
  disk: opt(WireDiskDetailsSchema),
});

const WireDiskSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  mountPath: Schema.String,
  sizeGB: Schema.Number,
});

const WireNativeEnvironmentDetailsSchema = Schema.Struct({
  buildCommand: defaultString,
  startCommand: defaultString,
  preDeployCommand: opt(Schema.String),
});

const WireDockerDetailsSchema = Schema.Struct({
  dockerCommand: opt(Schema.String),
  dockerContext: opt(Schema.String),
  dockerfilePath: opt(Schema.String),
  preDeployCommand: opt(Schema.String),
  registryCredential: opt(
    Schema.Struct({
      id: Schema.String,
      name: opt(Schema.String),
    }),
  ),
});

const WireServiceDetailsSchema: Schema.Codec<WireServiceDetails, unknown, never, never> =
  Schema.Struct({
    plan: opt(Schema.String),
    region: opt(openEnum<Region>()),
    runtime: opt(Schema.String),
    env: opt(Schema.String),
    buildPlan: opt(Schema.String),
    numInstances: opt(Schema.Number),
    autoscaling: opt(AutoscalingConfigSchema),
    disk: opt(WireDiskSchema),
    healthCheckPath: opt(Schema.String),
    url: opt(Schema.String),
    openPorts: optArray(
      Schema.Struct({
        port: Schema.Number,
        protocol: Schema.String,
      }),
    ),
    sshAddress: opt(Schema.String),
    schedule: opt(Schema.String),
    lastSuccessfulRunAt: opt(Schema.String),
    buildCommand: opt(Schema.String),
    publishPath: opt(Schema.String),
    ipAllowList: optArray(CidrBlockAndDescriptionSchema),
    maintenanceMode: opt(
      Schema.Struct({
        enabled: opt(Schema.Boolean),
        uri: opt(Schema.String),
      }),
    ),
    maxShutdownDelaySeconds: opt(Schema.Number),
    previews: opt(
      Schema.Struct({
        generation: opt(
          Schema.Literals([
            "off",
            "manual",
            "automatic",
          ] satisfies ReadonlyArray<PreviewsGeneration>),
        ),
      }),
    ),
    pullRequestPreviewsEnabled: opt(Schema.Literals(["yes", "no"])),
    renderSubdomainPolicy: opt(
      Schema.Literals(["enabled", "disabled"] satisfies ReadonlyArray<RenderSubdomainPolicy>),
    ),
    cache: opt(
      Schema.Struct({
        profile: Schema.Literals([
          "no-cache",
          "origin-controlled",
          "origin-controlled-all",
        ] satisfies ReadonlyArray<CacheProfile>),
      }),
    ),
    envSpecificDetails: opt(
      Schema.Union([WireNativeEnvironmentDetailsSchema, WireDockerDetailsSchema]),
    ),
  });

export const WireServiceSchema: Schema.Codec<WireService, unknown, never, never> = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  slug: Schema.String,
  type: Schema.Literals([
    "web_service",
    "private_service",
    "background_worker",
    "cron_job",
    "static_site",
  ] satisfies ReadonlyArray<ServiceType>),
  ownerId: Schema.String,
  environmentId: opt(Schema.String),
  repo: opt(Schema.String),
  branch: opt(Schema.String),
  rootDir: opt(Schema.String),
  imagePath: opt(Schema.String),
  autoDeploy: Schema.String.pipe(
    Schema.NullOr,
    Schema.optional,
    Schema.decodeTo(Schema.Literals(["yes", "no"]), {
      decode: SchemaGetter.transform((v) => (v === "yes" ? "yes" : "no")),
      encode: SchemaGetter.forbiddenEncoding,
    }),
  ),
  autoDeployTrigger: opt(Schema.Literals(["off", "commit", "checksPass"])),
  buildFilter: opt(
    Schema.Struct({
      paths: defaultArray(Schema.String),
      ignoredPaths: defaultArray(Schema.String),
    }),
  ),
  registryCredential: opt(
    Schema.Struct({
      id: Schema.String,
      name: defaultString,
    }),
  ),
  dashboardUrl: Schema.String,
  notifyOnFail: opt(
    Schema.Literals(["default", "ignore", "notify"] satisfies ReadonlyArray<NotifySetting>),
  ),
  suspended: openEnum<WireService["suspended"]>(),
  suspenders: defaultArray(Schema.String),
  serviceDetails: WireServiceDetailsSchema,
  createdAt: Schema.String,
  updatedAt: Schema.String,
});

export const WireServiceWithCursorSchema: Schema.Decoder<WireServiceWithCursor> = Schema.Struct({
  cursor: defaultString,
  service: WireServiceSchema,
});

const WireServiceAndDeployObjectSchema = Schema.Struct({
  service: opt(WireServiceSchema),
  deployId: opt(Schema.String),
});

export const WireServiceAndDeploySchema: Schema.Decoder<WireServiceAndDeploy> = Schema.Union([
  WireServiceAndDeployObjectSchema,
  WireServiceSchema.pipe(
    Schema.decodeTo(Schema.toType(WireServiceAndDeployObjectSchema), {
      decode: SchemaGetter.transform((service) => ({ service, deployId: undefined })),
      encode: SchemaGetter.forbiddenEncoding,
    }),
  ),
]);

export const WireCustomDomainSchema: Schema.Codec<WireCustomDomain, unknown, never, never> =
  Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    domainType: Schema.String,
    publicSuffix: defaultString,
    redirectForName: defaultString,
    verificationStatus: Schema.String,
    server: opt(
      Schema.Struct({
        id: opt(Schema.String),
        name: opt(Schema.String),
      }),
    ),
    createdAt: Schema.String,
  });

export const WireCustomDomainListSchema: Schema.Decoder<WireCustomDomain[]> =
  nullableArray(WireCustomDomainSchema);

export const WireCustomDomainWithCursorSchema: Schema.Decoder<WireCustomDomainWithCursor> =
  Schema.Struct({
    cursor: defaultString,
    customDomain: WireCustomDomainSchema,
  });

export const WireHeaderSchema: Schema.Codec<WireHeader, unknown, never, never> = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  path: Schema.String,
  value: Schema.String,
});

export const WireHeaderListSchema: Schema.Decoder<WireHeader[]> = nullableArray(WireHeaderSchema);

export const WireHeaderWithCursorSchema: Schema.Decoder<WireHeaderWithCursor> = Schema.Struct({
  cursor: defaultString,
  header: WireHeaderSchema,
});

export const WireRouteSchema: Schema.Codec<WireRoute, unknown, never, never> = Schema.Struct({
  id: Schema.String,
  source: Schema.String,
  destination: Schema.String,
  type: Schema.Literals(["redirect", "rewrite"] satisfies ReadonlyArray<RouteType>),
  priority: Schema.Number,
});

export const WireRouteListSchema: Schema.Decoder<WireRoute[]> = nullableArray(WireRouteSchema);

export const WireRouteWithCursorSchema: Schema.Decoder<WireRouteWithCursor> = Schema.Struct({
  cursor: defaultString,
  route: WireRouteSchema,
});

export const WireDeploySchema: Schema.Codec<WireDeploy, unknown, never, never> = Schema.Struct({
  id: Schema.String,
  status: opt(openEnum<DeployStatus>()),
  trigger: opt(Schema.String),
  createdAt: opt(Schema.String),
  updatedAt: opt(Schema.String),
  startedAt: opt(Schema.String),
  finishedAt: opt(Schema.String),
});

export const WireDeployWithCursorSchema: Schema.Decoder<WireDeployWithCursor> = Schema.Struct({
  cursor: opt(Schema.String),
  deploy: opt(WireDeploySchema),
});

export const WireDeployCreateResponseSchema: Schema.Decoder<WireDeploy | undefined> = Schema.Union([
  WireDeploySchema,
  Schema.Struct({ deploy: opt(WireDeploySchema) }).pipe(
    Schema.decodeTo(WireDeploySchema.pipe(Schema.toType, Schema.UndefinedOr), {
      decode: SchemaGetter.transform((v) => v.deploy),
      encode: SchemaGetter.forbiddenEncoding,
    }),
  ),
  Schema.Null.pipe(
    Schema.decodeTo(Schema.Undefined, {
      decode: SchemaGetter.transform(() => undefined),
      encode: SchemaGetter.forbiddenEncoding,
    }),
  ),
]);

const StringRecordSchema = Schema.Record(Schema.String, Schema.String);

const WirePostgresReadReplicaSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  parameterOverrides: opt(StringRecordSchema),
});

export const WirePostgresSchema: Schema.Codec<WirePostgres, unknown, never, never> = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  owner: WireOwnerSchema,
  plan: Schema.String,
  region: openEnum<Region>(),
  version: Schema.String,
  databaseName: Schema.String,
  databaseUser: Schema.String,
  diskSizeGB: opt(Schema.Number),
  diskAutoscalingEnabled: defaultBoolean,
  highAvailabilityEnabled: defaultBoolean,
  environmentId: opt(Schema.String),
  ipAllowList: defaultArray(CidrBlockAndDescriptionSchema),
  readReplicas: defaultArray(WirePostgresReadReplicaSchema),
  parameterOverrides: opt(StringRecordSchema),
  connectionPool: opt(openEnum<PostgresConnectionPool>()),
  primaryPostgresID: opt(Schema.String),
  role: Schema.String,
  status: openEnum<DatabaseStatus>(),
  suspended: Schema.String,
  suspenders: defaultArray(Schema.String),
  dashboardUrl: Schema.String,
  expiresAt: opt(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});

export const WirePostgresWithCursorSchema: Schema.Decoder<WirePostgresWithCursor> = Schema.Struct({
  cursor: defaultString,
  postgres: WirePostgresSchema,
});

export const WirePostgresConnectionInfoSchema: Schema.Decoder<WirePostgresConnectionInfo> =
  Schema.Struct({
    externalConnectionString: Schema.String,
    internalConnectionString: Schema.String,
    password: Schema.String,
    psqlCommand: Schema.String,
  });

export const WirePostgresRecoveryInfoSchema: Schema.Decoder<WirePostgresRecoveryInfo> =
  Schema.Struct({
    recoveryStatus: Schema.String,
    startsAt: opt(Schema.String),
  });

export const WirePostgresExportSchema: Schema.Codec<WirePostgresExport, unknown, never, never> =
  Schema.Struct({
    id: Schema.String,
    url: opt(Schema.String),
    createdAt: opt(Schema.String),
  });

export const WirePostgresExportListSchema: Schema.Decoder<WirePostgresExport[]> =
  nullableArray(WirePostgresExportSchema);

const DatastoreOptionsSchema = Schema.Struct({
  maxmemoryPolicy: opt(openEnum<MaxmemoryPolicy | (string & {})>()),
  persistenceMode: opt(openEnum<PersistenceMode | (string & {})>()),
});

export const WireKeyValueSchema: Schema.Codec<WireKeyValue, unknown, never, never> = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  owner: WireOwnerSchema,
  plan: Schema.String,
  region: openEnum<Region>(),
  version: Schema.String,
  environmentId: opt(Schema.String),
  ipAllowList: defaultArray(CidrBlockAndDescriptionSchema),
  options: DatastoreOptionsSchema,
  status: openEnum<DatabaseStatus>(),
  dashboardUrl: opt(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});

export const WireKeyValueWithCursorSchema: Schema.Decoder<WireKeyValueWithCursor> = Schema.Struct({
  cursor: defaultString,
  keyValue: WireKeyValueSchema,
});

export const WireKeyValueConnectionInfoSchema: Schema.Decoder<WireKeyValueConnectionInfo> =
  Schema.Struct({
    cliCommand: Schema.String,
    externalConnectionString: Schema.String,
    internalConnectionString: Schema.String,
  });

export const WireRedisSchema: Schema.Codec<WireRedis, unknown, never, never> = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  owner: WireOwnerSchema,
  plan: Schema.String,
  region: openEnum<Region>(),
  version: Schema.String,
  environmentId: opt(Schema.String),
  ipAllowList: defaultArray(CidrBlockAndDescriptionSchema),
  options: DatastoreOptionsSchema,
  status: openEnum<DatabaseStatus>(),
  dashboardUrl: opt(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});

export const WireRedisWithCursorSchema: Schema.Decoder<WireRedisWithCursor> = Schema.Struct({
  cursor: defaultString,
  redis: WireRedisSchema,
});

export const WireRedisConnectionInfoSchema: Schema.Decoder<WireRedisConnectionInfo> = Schema.Struct(
  {
    redisCLICommand: Schema.String,
    externalConnectionString: Schema.String,
    internalConnectionString: Schema.String,
  },
);

export const WireWebhookSchema: Schema.Codec<WireWebhook, unknown, never, never> = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  url: Schema.String,
  enabled: Schema.Boolean,
  eventFilter: defaultArray(Schema.String),
  secret: Schema.String,
});

export const WireWebhookWithCursorSchema: Schema.Decoder<WireWebhookWithCursor> = Schema.Struct({
  cursor: defaultString,
  webhook: WireWebhookSchema,
});

export const WireDedicatedIpSchema: Schema.Codec<WireDedicatedIp, unknown, never, never> =
  Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    ownerId: Schema.String,
    region: openEnum<Region>(),
    description: defaultString,
    environmentIds: defaultArray(Schema.String),
    ips: defaultArray(Schema.String),
    status: openEnum<DedicatedIpStatus>(),
    createdAt: Schema.String,
    updatedAt: opt(Schema.String),
  });

export const WireDedicatedIpListSchema: Schema.Decoder<WireDedicatedIp[]> =
  nullableArray(WireDedicatedIpSchema);

export const WireOwnerLogStreamSettingSchema: Schema.Decoder<WireOwnerLogStreamSetting> =
  Schema.Struct({
    ownerId: opt(Schema.String),
    endpoint: opt(Schema.String),
    preview: opt(
      Schema.Literals(["send", "drop"] satisfies ReadonlyArray<LogStreamPreviewSetting>),
    ),
  });

export const WireResourceLogStreamSettingSchema: Schema.Decoder<WireResourceLogStreamSetting> =
  Schema.Struct({
    resourceId: opt(Schema.String),
    endpoint: opt(Schema.String),
    setting: opt(Schema.Literals(["send", "drop"] satisfies ReadonlyArray<LogStreamSetting>)),
  });

export const WireMetricsStreamSchema: Schema.Decoder<WireMetricsStream> = Schema.Struct({
  ownerId: Schema.String,
  provider: Schema.Literals([
    "BETTER_STACK",
    "CUSTOM",
    "DATADOG",
    "GRAFANA",
    "GROUNDCOVER",
    "HONEYCOMB",
    "NEW_RELIC",
    "SIGNOZ",
  ] satisfies ReadonlyArray<OtelProviderType>),
  url: Schema.String,
});

export const WireNotificationSettingSchema: Schema.Decoder<WireNotificationSetting> = Schema.Struct(
  {
    ownerId: Schema.String,
    emailEnabled: Schema.Boolean,
    slackEnabled: Schema.Boolean,
    notificationsToSend: Schema.Literals([
      "all",
      "failure",
      "none",
    ] satisfies ReadonlyArray<NotifySettingV2>),
    previewNotificationsEnabled: Schema.Boolean,
  },
);

export const WireNotificationOverrideSchema: Schema.Decoder<WireNotificationOverride> =
  Schema.Struct({
    serviceId: Schema.String,
    notificationsToSend: Schema.Literals([
      "all",
      "default",
      "failure",
      "none",
    ] satisfies ReadonlyArray<NotifyOverride>),
    previewNotificationsEnabled: Schema.Literals([
      "default",
      "true",
      "false",
    ] satisfies ReadonlyArray<NotifyPreviewOverride>),
  });

export const WireWorkflowSchema: Schema.Codec<WireWorkflow, unknown, never, never> = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  slug: opt(Schema.String),
  ownerId: Schema.String,
  environmentId: opt(Schema.String),
  region: openEnum<Region>(),
  runtime: opt(openEnum<WorkflowRuntime>()),
  repo: opt(Schema.String),
  branch: opt(Schema.String),
  rootDir: opt(Schema.String),
  buildCommand: opt(Schema.String),
  runCommand: Schema.String,
  buildConfig: opt(
    Schema.Struct({
      runtime: opt(openEnum<WorkflowRuntime>()),
      repo: opt(Schema.String),
      branch: opt(Schema.String),
      rootDir: opt(Schema.String),
      buildCommand: opt(Schema.String),
    }),
  ),
  autoDeployTrigger: opt(Schema.Literals(["off", "commit", "checksPass"])),
  defaultVersionId: opt(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});

export const WireWorkflowWithCursorSchema: Schema.Decoder<WireWorkflowWithCursor> = Schema.Struct({
  cursor: opt(Schema.String),
  workflow: opt(WireWorkflowSchema),
});

export const WireWorkflowVersionSchema: Schema.Codec<WireWorkflowVersion, unknown, never, never> =
  Schema.Struct({
    id: Schema.String,
    workflowId: Schema.String,
    name: opt(Schema.String),
    status: opt(Schema.String),
    createdAt: opt(Schema.String),
    updatedAt: opt(Schema.String),
  });

export const WireWorkflowVersionWithCursorSchema: Schema.Decoder<WireWorkflowVersionWithCursor> =
  Schema.Struct({
    cursor: opt(Schema.String),
    workflowVersion: opt(WireWorkflowVersionSchema),
  });

export const WireTaskRunSchema: Schema.Codec<WireTaskRun, unknown, never, never> = Schema.Struct({
  id: Schema.String,
  task: Schema.optional(Schema.Union([Schema.String, Schema.Struct({ slug: Schema.String })])).pipe(
    Schema.decodeTo(Schema.String, {
      decode: SchemaGetter.transform((v) =>
        typeof v === "string" ? v : v && typeof v.slug === "string" ? v.slug : "",
      ),
      encode: SchemaGetter.forbiddenEncoding,
    }),
  ),
  status: openEnum<TaskRunStatus>(),
  input: Schema.optional(Schema.Unknown),
  results: Schema.optional(Schema.Unknown),
  output: Schema.optional(Schema.Unknown),
  error: opt(Schema.String),
  startedAt: opt(Schema.String),
  completedAt: opt(Schema.String),
  finishedAt: opt(Schema.String),
  createdAt: opt(Schema.String),
  updatedAt: opt(Schema.String),
});

export const WireTaskRunWithCursorSchema: Schema.Decoder<WireTaskRunWithCursor> = Schema.Struct({
  cursor: opt(Schema.String),
  taskRun: opt(WireTaskRunSchema),
});

const WireBlueprintResourceSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  type: Schema.String,
});

export const WireBlueprintSchema: Schema.Codec<WireBlueprint, unknown, never, never> =
  Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    ownerId: Schema.String,
    repo: Schema.String,
    branch: Schema.String,
    path: Schema.String,
    status: openEnum<BlueprintStatus>(),
    autoSync: Schema.Boolean,
    lastSync: opt(Schema.String),
  });

export const WireBlueprintWithCursorSchema: Schema.Decoder<WireBlueprintWithCursor> = Schema.Struct(
  {
    cursor: opt(Schema.String),
    blueprint: opt(WireBlueprintSchema),
  },
);

export const WireBlueprintDetailSchema: Schema.Decoder<WireBlueprintDetail> = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  ownerId: Schema.String,
  repo: Schema.String,
  branch: Schema.String,
  path: Schema.String,
  status: openEnum<BlueprintStatus>(),
  autoSync: Schema.Boolean,
  lastSync: opt(Schema.String),
  resources: optArray(WireBlueprintResourceSchema),
});

const WireBlueprintSyncSchema = Schema.Struct({
  id: Schema.String,
  state: Schema.String,
  commit: opt(
    Schema.Struct({
      id: opt(Schema.String),
      message: opt(Schema.String),
      url: opt(Schema.String),
    }),
  ),
  startedAt: opt(Schema.String),
  completedAt: opt(Schema.String),
});

export const WireBlueprintSyncWithCursorSchema: Schema.Decoder<WireBlueprintSyncWithCursor> =
  Schema.Struct({
    cursor: opt(Schema.String),
    sync: opt(WireBlueprintSyncSchema),
  });

export const WireBlueprintValidateResponseSchema: Schema.Decoder<WireBlueprintValidateResponse> =
  Schema.Struct({
    valid: opt(Schema.Boolean),
    error: opt(Schema.String),
    plan: Schema.optional(Schema.Unknown),
  });

const WireLogLabelSchema = Schema.Struct({
  name: Schema.String,
  value: opt(Schema.String),
});

const WireLogEntrySchema: Schema.Codec<WireLogEntry, unknown, never, never> = Schema.Struct({
  id: Schema.String,
  timestamp: Schema.String,
  message: Schema.String,
  labels: optArray(WireLogLabelSchema),
});

export const WireLogsResponseSchema: Schema.Decoder<WireLogsResponse> = Schema.Struct({
  hasMore: Schema.Boolean,
  nextStartTime: opt(Schema.String),
  nextEndTime: opt(Schema.String),
  logs: defaultArray(WireLogEntrySchema),
});
