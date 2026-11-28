import type * as Redacted from "effect/Redacted";

/** Plain string or `Redacted<string>` accepted for secret configuration props. */
export type SecretString = string | Redacted.Redacted<string>;

export type Region = "oregon" | "ohio" | "virginia" | "frankfurt" | "singapore" | (string & {});

export type ServicePlan =
  | "free"
  | "starter"
  | "starter_plus"
  | "standard"
  | "standard_plus"
  | "pro"
  | "pro_plus"
  | "pro_max"
  | "pro_ultra"
  | "custom"
  | (string & {});

export type BuildPlan = "starter" | "performance" | (string & {});

export type PaidPlan =
  | "starter"
  | "standard"
  | "pro"
  | "pro_plus"
  | "pro_max"
  | "pro_ultra"
  | "custom"
  | (string & {});

export type PostgresPlan =
  | "free"
  | "basic_256mb"
  | "basic_1gb"
  | "basic_4gb"
  | "pro_4gb"
  | "pro_8gb"
  | "pro_16gb"
  | "pro_32gb"
  | "pro_64gb"
  | "pro_128gb"
  | "pro_192gb"
  | "pro_256gb"
  | "pro_384gb"
  | "pro_512gb"
  | "accelerated_16gb"
  | "accelerated_32gb"
  | "accelerated_64gb"
  | "accelerated_128gb"
  | "accelerated_256gb"
  | "accelerated_384gb"
  | "accelerated_512gb"
  | "accelerated_768gb"
  | "accelerated_1024gb"
  | "starter"
  | "standard"
  | "pro"
  | "pro_plus"
  | "custom"
  | (string & {});

export type KeyValuePlan =
  | "free"
  | "starter"
  | "standard"
  | "pro"
  | "pro_plus"
  | "custom"
  | (string & {});

export type RedisPlan = KeyValuePlan;

export type PostgresVersion = "11" | "12" | "13" | "14" | "15" | "16" | "17" | "18" | (string & {});

export type PostgresConnectionPool = "pgbouncer" | "none" | (string & {});

export type WorkflowRuntime =
  | "elixir"
  | "go"
  | "node"
  | "python"
  | "ruby"
  | "docker"
  | (string & {});

export type TaskRunStatus =
  | "pending"
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "canceled"
  | (string & {});

export type BlueprintStatus = "created" | "syncing" | "synced" | "paused" | "error" | (string & {});

export type NativeRuntime = "elixir" | "go" | "node" | "python" | "ruby" | "rust";

export type ServiceRuntime = NativeRuntime | "docker" | "image" | (string & {});

export type ServiceType =
  | "web_service"
  | "private_service"
  | "background_worker"
  | "cron_job"
  | "static_site";

export type AutoDeployTrigger = "off" | "commit" | "checksPass";

export type PreviewsGeneration = "off" | "manual" | "automatic" | (string & {});

export type ProtectedStatus = "protected" | "unprotected";

export type MaxmemoryPolicy =
  | "allkeys_lfu"
  | "allkeys_lru"
  | "allkeys_random"
  | "noeviction"
  | "volatile_lfu"
  | "volatile_lru"
  | "volatile_random"
  | "volatile_ttl";

export type PersistenceMode = "journal_snapshot" | "snapshot" | "off";

export type RegistryType = "AWS_ECR" | "DOCKER" | "GITHUB" | "GITLAB" | "GOOGLE_ARTIFACT";

export type RouteType = "redirect" | "rewrite";

export type OtelProviderType =
  | "BETTER_STACK"
  | "CUSTOM"
  | "DATADOG"
  | "GRAFANA"
  | "GROUNDCOVER"
  | "HONEYCOMB"
  | "NEW_RELIC"
  | "SIGNOZ";

export type LogStreamSetting = "send" | "drop";

export type LogStreamPreviewSetting = "send" | "drop";

export type NotifySetting = "default" | "ignore" | "notify";

export type NotifySettingV2 = "all" | "failure" | "none";

export type NotifyOverride = "all" | "default" | "failure" | "none";

export type NotifyPreviewOverride = "default" | "true" | "false";

export type DatabaseStatus =
  | "creating"
  | "available"
  | "unavailable"
  | "config_restart"
  | "suspended"
  | "updating_instance"
  | "maintenance_in_progress"
  | "maintenance_scheduled"
  | "recovery_in_progress"
  | "recovery_failed"
  | "unknown"
  | (string & {});

export type DedicatedIpStatus =
  | "CREATING"
  | "PENDING"
  | "RUNNING"
  | "FAILED"
  | "DELETING"
  | "DELETED"
  | "UNKNOWN"
  | (string & {});

export type DeployStatus =
  | "created"
  | "build_in_progress"
  | "build_failed"
  | "update_in_progress"
  | "update_failed"
  | "pre_deploy_in_progress"
  | "pre_deploy_failed"
  | "live"
  | "deactivated"
  | "canceled"
  | "queued"
  | (string & {});

export type CacheProfile = "no-cache" | "origin-controlled" | "origin-controlled-all";

export type RenderSubdomainPolicy = "enabled" | "disabled";

export interface CidrBlockAndDescription {
  /** IPv4 CIDR block permitted to access the resource (e.g. `"0.0.0.0/0"`). */
  cidrBlock: string;
  /** Human-readable description for this CIDR entry. */
  description: string;
}

export interface BuildFilter {
  /** Repository paths that trigger a new build when modified. */
  paths?: string[];
  /** Repository paths ignored by automatic builds. */
  ignoredPaths?: string[];
}

export interface PreviewsConfig {
  /** Pull request preview generation mode. */
  generation?: PreviewsGeneration;
}

export interface MaintenanceMode {
  /** Whether maintenance mode is active. */
  enabled?: boolean;
  /** Custom URI to redirect visitors to while maintenance mode is enabled. */
  uri?: string;
}

export interface AutoscalingCriteriaPercentage {
  /** Whether scaling on this metric is enabled. */
  enabled: boolean;
  /** Target utilization percentage threshold. */
  percentage: number;
}

export interface AutoscalingCriteria {
  /** CPU utilization scaling rule. */
  cpu: AutoscalingCriteriaPercentage;
  /** Memory utilization scaling rule. */
  memory: AutoscalingCriteriaPercentage;
}

export interface AutoscalingConfig {
  /** Whether autoscaling is enabled for the service. */
  enabled: boolean;
  /** Minimum number of running instances. */
  min: number;
  /** Maximum number of running instances. */
  max: number;
  /** Resource utilization criteria governing scaling. */
  criteria: AutoscalingCriteria;
}

export interface DiskConfig {
  /** Persistent disk name. */
  name: string;
  /** Absolute container mount path starting with `/`. */
  mountPath: string;
  /** Disk capacity in GiB (1-1000). */
  sizeGB?: number;
}

export interface DiskAttributes {
  /** Unique disk identifier. */
  id: string;
  /** Persistent disk name. */
  name: string;
  /** Absolute container mount path. */
  mountPath: string;
  /** Disk capacity in GiB. */
  sizeGB: number;
}

export interface CustomDomainInfo {
  /** Custom domain identifier. */
  id: string;
  /** Fully-qualified custom domain name. */
  name: string;
  /** `"apex"` or `"subdomain"`. */
  domainType: string;
  /** Public suffix extracted for the domain. */
  publicSuffix: string;
  /** Canonical domain redirected from this domain, if any. */
  redirectForName: string;
  /** Verification status (`"verified"` or `"unverified"`). */
  verificationStatus: string;
  /** Optional target server ID and name. */
  server?: {
    id?: string;
    name?: string;
  };
  /** Creation timestamp (ISO 8601). */
  createdAt: string;
}

export type EnvVarValueSpec =
  | SecretString
  | { readonly value: SecretString }
  | { readonly generateValue: true };

export interface NativeRuntimeSource {
  /** Native language runtime (`elixir`, `go`, `node`, `python`, `ruby`, `rust`). */
  runtime: NativeRuntime;
  /** Git repository URL. */
  repo: string;
  /** Git branch to build and deploy. */
  branch: string;
  /** Shell command executed during build. */
  buildCommand: string;
  /** Enable automatic deploys on push/PR checks. */
  autoDeploy?: boolean;
  /** Granular auto-deploy trigger (`"commit"`, `"checksPass"`, or `"off"`). */
  autoDeployTrigger?: AutoDeployTrigger;
  /** Optional path filters controlling auto-deploys. */
  buildFilter?: BuildFilter;
}

export interface DockerRuntimeSource {
  /** Git repository URL. */
  repo: string;
  /** Git branch to build and deploy. */
  branch: string;
  /** Docker build context relative to repo root. Defaults to `"."`. */
  context?: string;
  /** Path to Dockerfile relative to repo root. Defaults to `"./Dockerfile"`. */
  dockerfilePath?: string;
  /** Optional registry credential ID for private base images. */
  registryCredentialId?: string;
  /** Enable automatic deploys on push/PR checks. */
  autoDeploy?: boolean;
  /** Granular auto-deploy trigger (`"commit"`, `"checksPass"`, or `"off"`). */
  autoDeployTrigger?: AutoDeployTrigger;
  /** Optional path filters controlling auto-deploys. */
  buildFilter?: BuildFilter;
}

export interface ImageRuntimeSource {
  /** Container image path (for example `"nginx:latest"` or `"ghcr.io/org/app@sha256:..."`, or combine `imagePath` with `tag` / `digest`). */
  imagePath: string;
  /** Optional image tag appended as `:tag`. Mutually exclusive with `digest`. */
  tag?: string;
  /** Optional image digest appended as `@digest`. Mutually exclusive with `tag`. */
  digest?: string;
  /** Optional registry credential ID for private container registries. */
  registryCredentialId?: string;
  /** Enable automatic deploys when image digest updates. */
  autoDeploy?: boolean;
  /** Granular auto-deploy trigger (`"commit"`, `"checksPass"`, or `"off"`). */
  autoDeployTrigger?: AutoDeployTrigger;
}

export type RuntimeSource =
  | { readonly nativeRuntime: NativeRuntimeSource; readonly docker?: never; readonly image?: never }
  | { readonly docker: DockerRuntimeSource; readonly nativeRuntime?: never; readonly image?: never }
  | { readonly image: ImageRuntimeSource; readonly nativeRuntime?: never; readonly docker?: never };

export interface NotificationOverrideConfig {
  /** Which deploy notifications to send for this service. */
  notificationsToSend?: NotifyOverride;
  /** Whether preview notifications are enabled (`"default"`, `"true"`, or `"false"`). */
  previewNotificationsEnabled?: NotifyPreviewOverride;
}

export interface LogStreamOverrideInput {
  /** Whether logs from this resource are sent or dropped. */
  setting: LogStreamSetting;
  /** Log stream ingestion endpoint (required when `setting === "send"`, omitted when `"drop"`). */
  endpoint?: string;
  /** Optional authentication token paired with `endpoint`. */
  token?: SecretString;
}

export interface LogStreamOverrideAttributes {
  /** Resource ID the log stream override applies to. */
  resourceId: string;
  /** Log stream setting (`"send"` or `"drop"`). */
  setting: LogStreamSetting;
  /** Log stream endpoint if configured. */
  endpoint?: string;
}

export interface StaticSiteHeaderInput {
  /** Request path pattern (supports wildcards) to attach the header to. */
  path: string;
  /** HTTP header name. */
  name: string;
  /** HTTP header value. */
  value: string;
}

export interface StaticSiteHeaderAttributes extends StaticSiteHeaderInput {
  /** Unique header rule ID. */
  id: string;
}

export interface StaticSiteRouteInput {
  /** Request path pattern to match. */
  source: string;
  /** Destination path to redirect or rewrite to. */
  destination: string;
  /** Route action (`"redirect"` or `"rewrite"`). */
  type: RouteType;
}

export interface StaticSiteRouteAttributes extends StaticSiteRouteInput {
  /** Unique route rule ID. */
  id: string;
  /** Zero-based route priority assigned by Render. */
  priority: number;
}

export interface OpenPortInfo {
  /** Exposed port number. */
  port: number;
  /** Protocol (`"TCP"` or `"UDP"`). */
  protocol: string;
}

export interface SecretFileOutput {
  /** Secret file name mounted into `/etc/secrets/`. */
  name: string;
  /** Redacted secret file content. */
  content: Redacted.Redacted<string>;
}

export interface PostgresRecoveryInfo {
  /** Point-in-time recovery availability status (for example `"AVAILABLE"` or `"NOT_AVAILABLE"`). */
  readonly recoveryStatus: string;
  /** Earliest timestamp covered by the backup/WAL retention window (ISO 8601). */
  readonly startsAt?: string;
}

export interface PostgresRestoreFrom {
  /** Source Render Postgres database ID (`dpg-...`) to restore from. */
  readonly sourcePostgresId: string;
  /** Target recovery point timestamp in ISO 8601 format. */
  readonly restoreTime: string;
}

export interface PostgresExportInfo {
  /** Logical database export identifier. */
  readonly id: string;
  /** Download URL for the logical export archive, when available. */
  readonly url?: string;
  /** Export creation timestamp (ISO 8601). */
  readonly createdAt?: string;
}
