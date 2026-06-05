import type * as Redacted from "effect/Redacted";

export const KNOWN_REGION_IDS = [
  "us-east-1",
  "us-west-1",
  "eu-west-3",
  "eu-central-1",
  "ap-northeast-1",
  "ap-southeast-1",
] as const;

export const REGIONS = KNOWN_REGION_IDS.map((id) => ({
  id,
  displayName: id,
}));

export interface Pagination {
  nextCursor: string | null;
  hasMore: boolean;
}

export interface ListResponse<T> {
  data: T[];
  pagination: Pagination;
}

export interface DataResponse<T> {
  data: T;
}

export interface ResourceRef {
  id: string;
  url: string;
  name: string;
}

export type PrismaRegionId = (typeof KNOWN_REGION_IDS)[number] | (string & {});

export type PrismaDatabaseRegionId = PrismaRegionId | "inherit";

export type PrismaBranchIdFilter = "unassigned" | (string & {});

export interface Workspace {
  id: string;
  type: "workspace";
  url: string;
  name: string;
  createdAt: string;
}

export interface CurrentPrincipal {
  user: {
    id: string;
    email: string;
    name: string | null;
  } | null;
  workspace: {
    id: string;
    name: string;
  } | null;
  credential: {
    type: "oauth" | "service_token" | "management_token";
    id: string | null;
    name: string | null;
  };
}

export interface Region {
  id: string;
  type: "region";
  name: string;
  product?: "postgres" | "accelerate";
  status?: "available" | "unavailable";
}

export interface Project {
  id: string;
  type: "project";
  url: string;
  name: string;
  createdAt: string;
  defaultRegion: string | null;
  workspace: ResourceRef;
}

export interface ProjectCreateInput {
  name?: string;
  createDatabase?: boolean;
  region?: PrismaRegionId;
}

export interface ProjectUpdateInput {
  name?: string;
  settings?: Record<string, unknown>;
}

export interface ProjectTransferInput {
  recipientAccessToken: string;
}

export type DatabaseStatus =
  | "failure"
  | "provisioning"
  | "ready"
  | "recovering";

export interface EndpointDetail {
  host: string;
  port: number;
}

export interface EndpointDetailWithSecret extends EndpointDetail {
  connectionString?: string;
}

export interface ConnectionEndpoints {
  direct?: EndpointDetail;
  pooled?: EndpointDetail;
  accelerate?: EndpointDetail;
}

export interface ConnectionEndpointsWithSecrets {
  direct?: EndpointDetailWithSecret;
  pooled?: EndpointDetailWithSecret;
  accelerate?: EndpointDetailWithSecret;
}

export interface DatabaseConnection {
  id: string;
  type: "connection";
  url: string;
  name: string;
  createdAt: string;
  kind: "postgres" | "accelerate";
  endpoints: ConnectionEndpoints;
  connectionString?: string;
  directConnection?: { host: string; pass: string; user: string } | null;
  host?: string | null;
  pass?: string | null;
  user?: string | null;
  database: ResourceRef;
}

export interface DatabaseConnectionWithSecrets extends Omit<
  DatabaseConnection,
  "endpoints"
> {
  endpoints: ConnectionEndpointsWithSecrets;
  connectionString?: string;
  host?: string | null;
  pass?: string | null;
  user?: string | null;
}

export interface ConnectionCreateInput {
  databaseId: string;
  name: string;
}

export interface DatabaseConnectionCreateInput extends Omit<
  ConnectionCreateInput,
  "databaseId"
> {}

export type DatabaseSource =
  | { type: "empty" }
  | { type: "database"; databaseId: string }
  | { type: "backup"; databaseId: string; backupId: string };

export interface Database {
  id: string;
  type: "database";
  url: string;
  name: string;
  status: DatabaseStatus;
  createdAt: string;
  isDefault: boolean;
  defaultConnectionId: string | null;
  connections: DatabaseConnection[];
  project: ResourceRef;
  region: { id: string; name: string } | null;
  source: DatabaseSource | null;
  branchId: string | null;
}

export interface DatabaseCreateInput {
  projectId: string;
  name?: string;
  region?: PrismaDatabaseRegionId;
  isDefault?: boolean;
  source?: DatabaseSourceInput;
  branchId?: string | null;
  branchGitName?: string | null;
}

export interface ProjectDatabaseCreateInput extends Omit<
  DatabaseCreateInput,
  "projectId" | "branchId" | "branchGitName"
> {
  /**
   * Deprecated Prisma API compatibility field for cloning from another
   * database. Prefer `source` for new callers.
   *
   * @deprecated Use `source` instead.
   */
  fromDatabase?: {
    id: string;
    backupId?: string;
  };
}

export interface DatabaseUpdateInput {
  name?: string;
  branchId?: string | null;
  branchGitName?: string | null;
}

export type DatabaseSourceInput =
  | { type: "empty" }
  | { type: "database"; databaseId: string }
  | { type: "backup"; databaseId: string; backupId: string };

export interface Backup {
  id: string;
  type?: "backup";
  backupType: "full" | "incremental";
  databaseId?: string;
  createdAt: string;
  size?: number;
  status: "running" | "completed" | "failed" | "unknown";
}

export interface BackupListResponse {
  data: Backup[];
  meta: {
    backupRetentionDays: number;
  };
  pagination: {
    hasMore: boolean;
    limit: number | null;
  };
}

export interface DatabaseUsage {
  period: { start: string; end: string };
  metrics: {
    operations: { used: number; unit: "ops" };
    storage: { used: number; unit: "GiB" };
  };
  generatedAt: string;
}

export interface RestoreDatabaseInput {
  source: { type: "backup"; databaseId: string; backupId: string };
}

export interface Branch {
  id: string;
  type: "branch";
  url: string;
  gitName: string;
  isDefault: boolean;
  role: "production" | "preview";
  createdAt: string;
  updatedAt: string;
  project: ResourceRef;
}

export interface BranchCreateInput {
  gitName: string;
  isDefault?: boolean;
}

export interface BranchUpdateInput {
  isDefault?: boolean | null;
}

export interface ComputeService {
  id: string;
  type: "compute-service";
  url: string;
  name: string;
  region: { id: string; name: string };
  projectId: string;
  branchId: string | null;
  latestVersionId: string | null;
  serviceEndpointDomain: string;
  createdAt: string;
}

export interface ComputeServiceCreateInput {
  projectId: string;
  displayName: string;
  regionId?: PrismaRegionId;
  branchId?: string | null;
  branchGitName?: string | null;
}

export interface ProjectComputeServiceCreateInput extends Omit<
  ComputeServiceCreateInput,
  "projectId"
> {}

export interface ComputeServiceUpdateInput {
  displayName?: string;
  branchId?: string | null;
  branchGitName?: string | null;
}

export interface ComputeVersionListItem {
  id: string;
  type: "compute-version";
  url: string;
  foundryVersionId: string;
  createdAt: string;
}

export interface ComputeVersion {
  id: string;
  type: "compute-version";
  url: string;
  foundryVersionId: string;
  status: string;
  previewDomain: string | null;
  envVars?: Record<string, string>;
  portMapping?: { http?: number };
  createdAt: string;
}

export interface ComputeVersionCreateInput {
  computeServiceId: string;
  portMapping?: { http?: number | null };
  skipCodeUpload?: boolean;
}

export interface ServiceComputeVersionCreateInput extends Omit<
  ComputeVersionCreateInput,
  "computeServiceId"
> {}

export interface ComputeVersionCreateResult {
  id: string;
  type: "compute-version";
  url: string;
  foundryVersionId: string;
  uploadUrl: string | null;
}

export interface StartComputeVersionResult {
  previewDomain: string;
}

export interface ComputeVersionLogsQuery {
  /**
   * Number of trailing log lines to stream first.
   */
  tail?: number;
  /**
   * Start from the beginning of the log stream.
   */
  fromStart?: boolean;
  /**
   * Raw Prisma API query key for callers that mirror the HTTP API.
   */
  from_start?: "true" | "false";
  /**
   * Reconnect cursor returned by a terminal log event.
   */
  cursor?: string;
}

export interface ComputeVersionLogsRequest {
  /**
   * WebSocket URL for `/v1/compute-services/versions/{versionId}/logs`.
   */
  url: string;
  /**
   * Headers to pass to a WebSocket client that supports custom headers.
   */
  headers: {
    Authorization: Redacted.Redacted<string>;
  };
}

export interface PromoteComputeServiceResult {
  serviceEndpointDomain: string;
  reassignedDomains: number;
}

export type CustomDomainStatus =
  | "pending_dns"
  | "verifying"
  | "verified_routing_blocked"
  | "provisioning_tls"
  | "active"
  | "failed"
  | "removing";

export type CustomDomainFailureCategory =
  | "dns"
  | "acme"
  | "storage"
  | "unknown";

export interface CustomDomainDnsRecord {
  type: "CNAME";
  name: string;
  value: string;
  ttl: number | null;
}

export interface CustomDomain {
  id: string;
  type: "custom-domain";
  url: string;
  hostname: string;
  computeServiceId: string;
  status: CustomDomainStatus;
  providerStatus: string;
  failureReason: string | null;
  failureCategory: CustomDomainFailureCategory | null;
  certExpiresAt: string | null;
  createdAt: string;
  updatedAt: string;
  dnsRecords: CustomDomainDnsRecord[];
}

export interface CustomDomainCreateInput {
  hostname: string;
}

export type EnvironmentVariableClass = "production" | "preview";

export interface EnvironmentVariable {
  id: string;
  type: "environment-variable";
  url: string;
  projectId: string;
  branchId: string | null;
  class: EnvironmentVariableClass;
  key: string;
  valueKid: string;
  isManagedBySystem: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface EnvironmentVariableCreateInput {
  projectId: string;
  branchId?: string;
  class: EnvironmentVariableClass;
  key: string;
  value: string;
}

export interface EnvironmentVariableUpdateInput {
  value: string;
}

export interface Integration {
  id: string;
  url: string;
  createdAt: string;
  scopes: string[];
  client: {
    id: string;
    name: string;
    createdAt: string;
  };
  createdByUser: {
    id: string;
    email: string;
    displayName: string | null;
  };
}

export interface ScmInstallation {
  id: string;
  type: "scm-installation";
  url: string;
  provider: "github";
  installationId: number;
  accountId: number;
  accountLogin: string;
  accountType: "user" | "organization";
  suspended: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ScmInstallIntentCreateInput {
  provider: "github";
  workspaceId: string;
}

export interface ScmInstallIntent {
  type: "install-intent";
  provider: "github";
  workspaceId: string;
  installUrl: string;
}

export interface ScmRepository {
  id: number;
  type: "scm-repository";
  fullName: string;
  defaultBranch: string;
  isPrivate: boolean;
}

export interface SourceRepository {
  id: string;
  type: "source-repository";
  url: string;
  repoId: number;
  provider: "github";
  repoFullName: string;
  defaultBranch: string;
  isPrivate: boolean;
  status: "active" | "archived";
  projectId: string;
  installationId: string;
  createdAt: string;
  updatedAt: string;
}

export interface SourceRepositoryCreateInput {
  projectId: string;
  provider: "github";
  providerRepositoryId: number;
  installationId?: string;
}

export interface PrismaSecretConnection {
  connectionString?: Redacted.Redacted<string>;
  directConnectionString?: Redacted.Redacted<string>;
  pooledConnectionString?: Redacted.Redacted<string>;
  accelerateConnectionString?: Redacted.Redacted<string>;
  host?: string | null;
  user?: string | null;
  password?: Redacted.Redacted<string>;
}
