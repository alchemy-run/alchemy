import * as Data from "effect/Data";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { PrismaEnvironment } from "./PrismaEnvironment.ts";
import type {
  App,
  AppCreateInput,
  AppDeploymentTarget,
  AppUpdateInput,
  Backup,
  BackupListResponse,
  Branch,
  BranchCreateInput,
  BranchUpdateInput,
  ComputeService,
  ComputeServiceCreateInput,
  ComputeServiceUpdateInput,
  ComputeVersion,
  ComputeVersionCreateInput,
  ComputeVersionCreateResult,
  ComputeVersionListItem,
  ComputeVersionLogsQuery,
  ComputeVersionLogsRequest,
  ConnectionCreateInput,
  CurrentPrincipal,
  CustomDomain,
  CustomDomainCreateInput,
  DataResponse,
  Database,
  DatabaseConnection,
  DatabaseConnectionCreateInput,
  DatabaseConnectionWithSecrets,
  DatabaseCreateInput,
  DatabaseUpdateInput,
  DatabaseUsage,
  Deployment,
  DeploymentCreateInput,
  DeploymentCreateResult,
  DeploymentListItem,
  EnvironmentVariable,
  EnvironmentVariableCreateInput,
  EnvironmentVariableUpdateInput,
  Integration,
  ListResponse,
  PrismaBranchIdFilter,
  PrismaSecretConnection,
  Project,
  ProjectComputeServiceCreateInput,
  ProjectCreateInput,
  ProjectDatabaseCreateInput,
  ProjectTransferInput,
  ProjectUpdateInput,
  PromoteAppResult,
  PromoteComputeServiceResult,
  RollbackAppResult,
  RollbackComputeServiceResult,
  Region,
  RestoreDatabaseInput,
  ScmInstallIntent,
  ScmInstallIntentCreateInput,
  ScmInstallation,
  ScmInstallationConnectInput,
  ScmRepository,
  ServiceComputeVersionCreateInput,
  SourceRepository,
  SourceRepositoryCreateInput,
  StartComputeVersionResult,
  StartDeploymentResult,
  Workspace,
} from "./Types.ts";

type Method = "GET" | "POST" | "PATCH" | "DELETE" | "PUT";

type ApiCustomDomain = Omit<CustomDomain, "providerStatus"> & {
  foundryStatus: string;
};

const normalizeCustomDomain = ({
  foundryStatus,
  ...domain
}: ApiCustomDomain): CustomDomain => ({
  ...domain,
  providerStatus: foundryStatus,
});

export class PrismaApiError extends Data.TaggedError("PrismaApiError")<{
  method: Method;
  path: string;
  status: number;
  message: string;
  body?: string;
}> {}

export class PrismaApiDecodeError extends Data.TaggedError(
  "PrismaApiDecodeError",
)<{
  method: Method;
  path: string;
  body: string;
  cause: unknown;
}> {}

export interface RequestOptions {
  query?: object;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface PrismaManagementClient {
  request<T>(
    method: Method,
    path: string,
    options?: RequestOptions,
  ): Effect.Effect<T, PrismaApiError | PrismaApiDecodeError>;
  paginate<T>(
    path: string,
    query?: object,
  ): Effect.Effect<T[], PrismaApiError | PrismaApiDecodeError>;
  listWorkspaces(
    query?: PaginationQuery,
  ): Effect.Effect<Workspace[], PrismaApiError | PrismaApiDecodeError>;
  getWorkspace(
    id: string,
  ): Effect.Effect<Workspace, PrismaApiError | PrismaApiDecodeError>;
  getCurrentPrincipal(): Effect.Effect<
    CurrentPrincipal,
    PrismaApiError | PrismaApiDecodeError
  >;
  listRegions(
    query?: RegionListQuery,
  ): Effect.Effect<Region[], PrismaApiError | PrismaApiDecodeError>;
  listPostgresRegions(): Effect.Effect<
    Region[],
    PrismaApiError | PrismaApiDecodeError
  >;
  listAccelerateRegions(): Effect.Effect<
    Region[],
    PrismaApiError | PrismaApiDecodeError
  >;
  listProjects(
    query?: PaginationQuery,
  ): Effect.Effect<Project[], PrismaApiError | PrismaApiDecodeError>;
  getProject(
    id: string,
  ): Effect.Effect<Project, PrismaApiError | PrismaApiDecodeError>;
  createProject(
    input: ProjectCreateInput,
  ): Effect.Effect<ProjectCreateResult, PrismaApiError | PrismaApiDecodeError>;
  updateProject(
    id: string,
    input: ProjectUpdateInput,
  ): Effect.Effect<Project, PrismaApiError | PrismaApiDecodeError>;
  deleteProject(
    id: string,
  ): Effect.Effect<void, PrismaApiError | PrismaApiDecodeError>;
  transferProject(
    id: string,
    input: ProjectTransferInput,
  ): Effect.Effect<void, PrismaApiError | PrismaApiDecodeError>;
  listDatabases(
    query?: DatabaseListQuery,
  ): Effect.Effect<Database[], PrismaApiError | PrismaApiDecodeError>;
  listProjectDatabases(
    projectId: string,
    query?: PaginationQuery,
  ): Effect.Effect<Database[], PrismaApiError | PrismaApiDecodeError>;
  getDatabase(
    id: string,
  ): Effect.Effect<Database, PrismaApiError | PrismaApiDecodeError>;
  createDatabase(
    input: DatabaseCreateInput,
  ): Effect.Effect<DatabaseCreateResult, PrismaApiError | PrismaApiDecodeError>;
  createProjectDatabase(
    projectId: string,
    input: ProjectDatabaseCreateInput,
  ): Effect.Effect<DatabaseCreateResult, PrismaApiError | PrismaApiDecodeError>;
  updateDatabase(
    id: string,
    input: DatabaseUpdateInput,
  ): Effect.Effect<Database, PrismaApiError | PrismaApiDecodeError>;
  deleteDatabase(
    id: string,
  ): Effect.Effect<void, PrismaApiError | PrismaApiDecodeError>;
  listBackups(
    databaseId: string,
    query?: BackupListQuery,
  ): Effect.Effect<BackupListResponse, PrismaApiError | PrismaApiDecodeError>;
  restoreDatabase(
    targetDatabaseId: string,
    input: RestoreDatabaseInput,
  ): Effect.Effect<Database, PrismaApiError | PrismaApiDecodeError>;
  getDatabaseUsage(
    databaseId: string,
    query?: Record<string, unknown>,
  ): Effect.Effect<DatabaseUsage, PrismaApiError | PrismaApiDecodeError>;
  listConnections(
    query?: ConnectionListQuery,
  ): Effect.Effect<DatabaseConnection[], PrismaApiError | PrismaApiDecodeError>;
  listDatabaseConnections(
    databaseId: string,
    query?: PaginationQuery,
  ): Effect.Effect<DatabaseConnection[], PrismaApiError | PrismaApiDecodeError>;
  getConnection(
    id: string,
  ): Effect.Effect<DatabaseConnection, PrismaApiError | PrismaApiDecodeError>;
  createConnection(
    input: ConnectionCreateInput,
  ): Effect.Effect<
    DatabaseConnectionWithSecrets,
    PrismaApiError | PrismaApiDecodeError
  >;
  createDatabaseConnection(
    databaseId: string,
    input: DatabaseConnectionCreateInput,
  ): Effect.Effect<
    DatabaseConnectionWithSecrets,
    PrismaApiError | PrismaApiDecodeError
  >;
  deleteConnection(
    id: string,
  ): Effect.Effect<void, PrismaApiError | PrismaApiDecodeError>;
  rotateConnection(
    id: string,
  ): Effect.Effect<
    DatabaseConnectionWithSecrets,
    PrismaApiError | PrismaApiDecodeError
  >;
  listBranches(
    projectId: string,
    query?: BranchListQuery,
  ): Effect.Effect<Branch[], PrismaApiError | PrismaApiDecodeError>;
  getBranch(
    id: string,
  ): Effect.Effect<Branch, PrismaApiError | PrismaApiDecodeError>;
  createBranch(
    projectId: string,
    input: BranchCreateInput,
  ): Effect.Effect<Branch, PrismaApiError | PrismaApiDecodeError>;
  updateBranch(
    id: string,
    input: BranchUpdateInput,
  ): Effect.Effect<Branch, PrismaApiError | PrismaApiDecodeError>;
  deleteBranch(
    id: string,
  ): Effect.Effect<void, PrismaApiError | PrismaApiDecodeError>;
  listComputeServices(
    query?: ComputeServiceListQuery,
  ): Effect.Effect<ComputeService[], PrismaApiError | PrismaApiDecodeError>;
  listProjectComputeServices(
    projectId: string,
    query?: PaginationQuery,
  ): Effect.Effect<ComputeService[], PrismaApiError | PrismaApiDecodeError>;
  getComputeService(
    id: string,
  ): Effect.Effect<ComputeService, PrismaApiError | PrismaApiDecodeError>;
  createComputeService(
    input: ComputeServiceCreateInput,
  ): Effect.Effect<ComputeService, PrismaApiError | PrismaApiDecodeError>;
  createProjectComputeService(
    projectId: string,
    input: ProjectComputeServiceCreateInput,
  ): Effect.Effect<ComputeService, PrismaApiError | PrismaApiDecodeError>;
  updateComputeService(
    id: string,
    input: ComputeServiceUpdateInput,
  ): Effect.Effect<ComputeService, PrismaApiError | PrismaApiDecodeError>;
  deleteComputeService(
    id: string,
  ): Effect.Effect<void, PrismaApiError | PrismaApiDecodeError>;
  promoteComputeService(
    id: string,
    versionId: string,
  ): Effect.Effect<
    PromoteComputeServiceResult,
    PrismaApiError | PrismaApiDecodeError
  >;
  rollbackComputeService(
    id: string,
    versionId: string,
  ): Effect.Effect<
    RollbackComputeServiceResult,
    PrismaApiError | PrismaApiDecodeError
  >;
  listComputeServiceDomains(
    computeServiceId: string,
  ): Effect.Effect<CustomDomain[], PrismaApiError | PrismaApiDecodeError>;
  createComputeServiceDomain(
    computeServiceId: string,
    input: CustomDomainCreateInput,
  ): Effect.Effect<CustomDomain, PrismaApiError | PrismaApiDecodeError>;
  getCustomDomain(
    id: string,
  ): Effect.Effect<CustomDomain, PrismaApiError | PrismaApiDecodeError>;
  deleteCustomDomain(
    id: string,
  ): Effect.Effect<void, PrismaApiError | PrismaApiDecodeError>;
  retryCustomDomain(
    id: string,
  ): Effect.Effect<CustomDomain, PrismaApiError | PrismaApiDecodeError>;
  listComputeVersions(
    query?: ComputeVersionListQuery,
  ): Effect.Effect<
    ComputeVersionListItem[],
    PrismaApiError | PrismaApiDecodeError
  >;
  listServiceComputeVersions(
    computeServiceId: string,
    query?: PaginationQuery,
  ): Effect.Effect<
    ComputeVersionListItem[],
    PrismaApiError | PrismaApiDecodeError
  >;
  getComputeVersion(
    id: string,
  ): Effect.Effect<ComputeVersion, PrismaApiError | PrismaApiDecodeError>;
  getComputeServiceVersion(
    id: string,
  ): Effect.Effect<ComputeVersion, PrismaApiError | PrismaApiDecodeError>;
  createComputeVersion(
    input: ComputeVersionCreateInput,
  ): Effect.Effect<
    ComputeVersionCreateResult,
    PrismaApiError | PrismaApiDecodeError
  >;
  createServiceComputeVersion(
    computeServiceId: string,
    input: ServiceComputeVersionCreateInput,
  ): Effect.Effect<
    ComputeVersionCreateResult,
    PrismaApiError | PrismaApiDecodeError
  >;
  deleteComputeVersion(
    id: string,
  ): Effect.Effect<void, PrismaApiError | PrismaApiDecodeError>;
  deleteComputeServiceVersion(
    id: string,
  ): Effect.Effect<void, PrismaApiError | PrismaApiDecodeError>;
  startComputeVersion(
    id: string,
  ): Effect.Effect<
    StartComputeVersionResult,
    PrismaApiError | PrismaApiDecodeError
  >;
  startComputeServiceVersion(
    id: string,
  ): Effect.Effect<
    StartComputeVersionResult,
    PrismaApiError | PrismaApiDecodeError
  >;
  stopComputeVersion(
    id: string,
  ): Effect.Effect<void, PrismaApiError | PrismaApiDecodeError>;
  stopComputeServiceVersion(
    id: string,
  ): Effect.Effect<void, PrismaApiError | PrismaApiDecodeError>;
  getComputeVersionLogsRequest(
    id: string,
    query?: ComputeVersionLogsQuery,
  ): Effect.Effect<ComputeVersionLogsRequest>;
  getComputeVersionLogsUrl(
    id: string,
    query?: ComputeVersionLogsQuery,
  ): Effect.Effect<string>;
  listApps(
    query?: AppListQuery,
  ): Effect.Effect<App[], PrismaApiError | PrismaApiDecodeError>;
  getApp(id: string): Effect.Effect<App, PrismaApiError | PrismaApiDecodeError>;
  createApp(
    input: AppCreateInput,
  ): Effect.Effect<App, PrismaApiError | PrismaApiDecodeError>;
  updateApp(
    id: string,
    input: AppUpdateInput,
  ): Effect.Effect<App, PrismaApiError | PrismaApiDecodeError>;
  deleteApp(
    id: string,
  ): Effect.Effect<void, PrismaApiError | PrismaApiDecodeError>;
  promoteApp(
    id: string,
    target: AppDeploymentTarget,
  ): Effect.Effect<PromoteAppResult, PrismaApiError | PrismaApiDecodeError>;
  rollbackApp(
    id: string,
    target: AppDeploymentTarget,
  ): Effect.Effect<RollbackAppResult, PrismaApiError | PrismaApiDecodeError>;
  listAppDomains(
    appId: string,
  ): Effect.Effect<CustomDomain[], PrismaApiError | PrismaApiDecodeError>;
  createAppDomain(
    appId: string,
    input: CustomDomainCreateInput,
  ): Effect.Effect<CustomDomain, PrismaApiError | PrismaApiDecodeError>;
  listAppDeployments(
    appId: string,
    query?: PaginationQuery,
  ): Effect.Effect<DeploymentListItem[], PrismaApiError | PrismaApiDecodeError>;
  createAppDeployment(
    appId: string,
    input: DeploymentCreateInput,
  ): Effect.Effect<
    DeploymentCreateResult,
    PrismaApiError | PrismaApiDecodeError
  >;
  getDeployment(
    id: string,
  ): Effect.Effect<Deployment, PrismaApiError | PrismaApiDecodeError>;
  deleteDeployment(
    id: string,
  ): Effect.Effect<void, PrismaApiError | PrismaApiDecodeError>;
  startDeployment(
    id: string,
  ): Effect.Effect<
    StartDeploymentResult,
    PrismaApiError | PrismaApiDecodeError
  >;
  stopDeployment(
    id: string,
  ): Effect.Effect<void, PrismaApiError | PrismaApiDecodeError>;
  getDeploymentLogsUrl(
    id: string,
    query?: ComputeVersionLogsQuery,
  ): Effect.Effect<string>;
  getBuildLogsUrl(
    buildId: string,
    query?: ComputeVersionLogsQuery,
  ): Effect.Effect<string>;
  listEnvironmentVariables(
    query?: EnvironmentVariableListQuery,
  ): Effect.Effect<
    EnvironmentVariable[],
    PrismaApiError | PrismaApiDecodeError
  >;
  getEnvironmentVariable(
    id: string,
  ): Effect.Effect<EnvironmentVariable, PrismaApiError | PrismaApiDecodeError>;
  createEnvironmentVariable(
    input: EnvironmentVariableCreateInput,
  ): Effect.Effect<EnvironmentVariable, PrismaApiError | PrismaApiDecodeError>;
  updateEnvironmentVariable(
    id: string,
    input: EnvironmentVariableUpdateInput,
  ): Effect.Effect<EnvironmentVariable, PrismaApiError | PrismaApiDecodeError>;
  deleteEnvironmentVariable(
    id: string,
  ): Effect.Effect<void, PrismaApiError | PrismaApiDecodeError>;
  listIntegrations(
    query: IntegrationListQuery,
  ): Effect.Effect<Integration[], PrismaApiError | PrismaApiDecodeError>;
  listWorkspaceIntegrations(
    workspaceId: string,
    query?: PaginationQuery,
  ): Effect.Effect<Integration[], PrismaApiError | PrismaApiDecodeError>;
  getIntegration(
    id: string,
  ): Effect.Effect<Integration, PrismaApiError | PrismaApiDecodeError>;
  deleteIntegration(
    id: string,
  ): Effect.Effect<void, PrismaApiError | PrismaApiDecodeError>;
  revokeWorkspaceIntegration(
    workspaceId: string,
    clientId: string,
  ): Effect.Effect<void, PrismaApiError | PrismaApiDecodeError>;
  listScmInstallations(query: {
    workspaceId: string;
    /**
     * Filter by connection state. Omit for connected rows plus (on full user
     * sessions) connectable installations of the caller's other workspaces.
     */
    connected?: boolean;
    cursor?: string | null;
    limit?: number;
  }): Effect.Effect<ScmInstallation[], PrismaApiError | PrismaApiDecodeError>;
  createScmInstallIntent(
    input: ScmInstallIntentCreateInput,
  ): Effect.Effect<ScmInstallIntent, PrismaApiError | PrismaApiDecodeError>;
  connectScmInstallation(
    installationId: string,
    input: ScmInstallationConnectInput,
  ): Effect.Effect<ScmInstallation, PrismaApiError | PrismaApiDecodeError>;
  listScmInstallationRepositories(
    installationId: string,
    query?: PaginationQuery,
  ): Effect.Effect<ScmRepository[], PrismaApiError | PrismaApiDecodeError>;
  listSourceRepositories(
    query: SourceRepositoryListQuery,
  ): Effect.Effect<SourceRepository[], PrismaApiError | PrismaApiDecodeError>;
  getSourceRepository(
    id: string,
  ): Effect.Effect<SourceRepository, PrismaApiError | PrismaApiDecodeError>;
  createSourceRepository(
    input: SourceRepositoryCreateInput,
  ): Effect.Effect<SourceRepository, PrismaApiError | PrismaApiDecodeError>;
  deleteSourceRepository(
    id: string,
  ): Effect.Effect<void, PrismaApiError | PrismaApiDecodeError>;
}

export class PrismaClient extends Context.Service<
  PrismaClient,
  PrismaManagementClient
>()("Prisma::PrismaClient") {}

export interface PaginationQuery {
  cursor?: string | null;
  limit?: number;
}

export interface BackupListQuery {
  limit?: number;
}

export interface RegionListQuery {
  product?: "postgres" | "accelerate";
}

export interface DatabaseListQuery extends PaginationQuery {
  projectId?: string;
  branchId?: PrismaBranchIdFilter;
  branchGitName?: string;
}

export interface ConnectionListQuery extends PaginationQuery {
  databaseId?: string;
}

export interface BranchListQuery extends PaginationQuery {
  gitName?: string;
  gitNameContains?: string;
}

export interface ComputeServiceListQuery extends PaginationQuery {
  projectId?: string;
  branchId?: PrismaBranchIdFilter;
  branchGitName?: string;
}

export interface ComputeVersionListQuery extends PaginationQuery {
  computeServiceId?: string;
}

export interface AppListQuery extends PaginationQuery {
  projectId?: string;
  branchId?: PrismaBranchIdFilter;
  branchGitName?: string;
}

export type { ComputeVersionLogsQuery, ComputeVersionLogsRequest };

export interface EnvironmentVariableListQuery extends PaginationQuery {
  projectId?: string;
  class?: "production" | "preview";
  key?: string;
  branchId?: string;
}

export interface IntegrationListQuery extends PaginationQuery {
  workspaceId: string;
}

export interface SourceRepositoryListQuery extends PaginationQuery {
  projectId: string;
}

export interface DatabaseCreateResult extends Database {
  connections: DatabaseConnectionWithSecrets[];
  apiKeys?: DatabaseConnectionWithSecrets[];
  connectionString?: string | null;
  directConnection?: { host: string; pass: string; user: string } | null;
}

export interface ProjectCreateDatabaseResult extends Omit<
  DatabaseCreateResult,
  "project"
> {}

export interface ProjectCreateResult extends Project {
  database: ProjectCreateDatabaseResult | null;
}

export const isNotFound = (error: unknown): boolean =>
  error instanceof PrismaApiError && error.status === 404;

export const isConflict = (error: unknown): boolean =>
  error instanceof PrismaApiError && error.status === 409;

const redactedString = (
  value: unknown,
): Redacted.Redacted<string> | undefined =>
  typeof value === "string" ? Redacted.make(value) : undefined;

export const extractConnectionSecrets = (
  connection:
    | DatabaseConnection
    | DatabaseConnectionWithSecrets
    | undefined
    | null,
): PrismaSecretConnection => {
  if (!connection) return {};
  const withSecrets = connection as DatabaseConnectionWithSecrets;
  const direct = withSecrets.endpoints?.direct?.connectionString;
  const pooled = withSecrets.endpoints?.pooled?.connectionString;
  const accelerate = withSecrets.endpoints?.accelerate?.connectionString;
  const legacy = connection.connectionString;
  const password = connection.pass ?? connection.directConnection?.pass;
  return {
    connectionString: redactedString(legacy),
    directConnectionString: redactedString(direct),
    pooledConnectionString: redactedString(pooled),
    accelerateConnectionString: redactedString(accelerate),
    host:
      connection.host ??
      connection.directConnection?.host ??
      withSecrets.endpoints?.direct?.host ??
      null,
    user: connection.user ?? connection.directConnection?.user ?? null,
    password: redactedString(password),
  };
};

export const requestBody = <T>(response: DataResponse<T>): T => response.data;

const isRetryableStatus = (status: number) =>
  status === 0 || status === 408 || status === 429 || status >= 500;

const isMutation = (method: Method) => method !== "GET";

const isRetryablePost = (path: string) =>
  path.endsWith("/start") ||
  path.endsWith("/stop") ||
  path.endsWith("/promote") ||
  path.endsWith("/rollback");

const isRetryableRequest = (method: Method, path: string) =>
  method === "GET" ||
  method === "DELETE" ||
  method === "PATCH" ||
  method === "PUT" ||
  (method === "POST" && isRetryablePost(path));

const retryTransient = <A, E, R>(
  method: Method,
  path: string,
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.retry({
      while: (e) =>
        e instanceof PrismaApiError &&
        isRetryableRequest(method, path) &&
        isRetryableStatus(e.status),
      schedule: Schedule.exponential("100 millis").pipe(
        Schedule.both(Schedule.recurs(4)),
      ),
    }),
  );

function makePrismaClient(): Effect.Effect<
  PrismaManagementClient,
  never,
  PrismaEnvironment | HttpClient.HttpClient
> {
  return Effect.gen(function* () {
    const env = yield* PrismaEnvironment;
    const http = yield* HttpClient.HttpClient;

    const buildUrl = (path: string, query?: object) =>
      Effect.sync(() => {
        const url = new URL(path, env.baseUrl);
        for (const [key, value] of Object.entries(query ?? {})) {
          if (value === undefined || value === null) continue;
          if (Array.isArray(value)) {
            for (const item of value)
              url.searchParams.append(key, String(item));
          } else {
            url.searchParams.set(key, String(value));
          }
        }
        return url.toString();
      });

    const buildWebSocketUrl = (path: string, query?: object) =>
      buildUrl(path, query).pipe(
        Effect.map((value) => {
          const url = new URL(value);
          if (url.protocol === "https:") url.protocol = "wss:";
          if (url.protocol === "http:") url.protocol = "ws:";
          return url.toString();
        }),
      );

    const logsQuery = (
      query: ComputeVersionLogsQuery | undefined,
    ): Record<string, unknown> | undefined => {
      if (!query) return undefined;
      const { fromStart, from_start, ...rest } = query;
      return {
        ...rest,
        from_start:
          from_start ??
          (fromStart === undefined ? undefined : String(fromStart)),
      };
    };

    const makeRequest = (
      method: Method,
      url: string,
      options: RequestOptions | undefined,
    ) => {
      const init =
        method === "GET"
          ? HttpClientRequest.get(url)
          : method === "POST"
            ? HttpClientRequest.post(url)
            : method === "PATCH"
              ? HttpClientRequest.patch(url)
              : method === "PUT"
                ? HttpClientRequest.put(url)
                : HttpClientRequest.delete(url);
      const request = init.pipe(
        HttpClientRequest.bearerToken(Redacted.value(env.serviceToken)),
        HttpClientRequest.setHeaders({
          Accept: "application/json",
          "User-Agent": "alchemy-prisma/1.0",
          ...options?.headers,
        }),
      );
      return options?.body === undefined
        ? request
        : request.pipe(HttpClientRequest.bodyJsonUnsafe(options.body));
    };

    const request = <T>(
      method: Method,
      path: string,
      options?: RequestOptions,
    ): Effect.Effect<T, PrismaApiError | PrismaApiDecodeError> =>
      retryTransient(
        method,
        path,
        Effect.gen(function* () {
          const url = yield* buildUrl(path, options?.query);
          const req = makeRequest(method, url, options);
          const response = Effect.gen(function* () {
            const res = yield* http.execute(req).pipe(
              Effect.mapError(
                (e) =>
                  new PrismaApiError({
                    method,
                    path,
                    status: 0,
                    message: e instanceof Error ? e.message : String(e),
                  }),
              ),
            );
            const text = yield* res.text.pipe(Effect.orElseSucceed(() => ""));
            return { status: res.status, text };
          });
          const { status, text } = yield* isMutation(method)
            ? response.pipe(Effect.uninterruptible)
            : response;
          if (status < 200 || status >= 300) {
            return yield* new PrismaApiError({
              method,
              path,
              status,
              message: parseErrorMessage(text) ?? `HTTP ${status}`,
              body: text,
            });
          }
          if (status === 204 || text.length === 0) {
            return undefined as T;
          }
          return yield* Effect.try({
            try: () => JSON.parse(text) as T,
            catch: (cause) =>
              new PrismaApiDecodeError({ method, path, body: text, cause }),
          });
        }),
      );

    const data = <T>(method: Method, path: string, options?: RequestOptions) =>
      request<DataResponse<T>>(method, path, options).pipe(
        Effect.map(requestBody),
      );

    const list = <T>(path: string, query?: object) =>
      request<ListResponse<T>>("GET", path, { query });

    const paginate = <T>(path: string, query?: object) =>
      Effect.gen(function* () {
        const items: T[] = [];
        const queryRecord = query as { cursor?: unknown } | undefined;
        let cursor =
          typeof queryRecord?.cursor === "string"
            ? queryRecord.cursor
            : undefined;
        do {
          const page = yield* list<T>(path, { ...query, cursor });
          items.push(...page.data);
          cursor = page.pagination.hasMore
            ? (page.pagination.nextCursor ?? undefined)
            : undefined;
        } while (cursor);
        return items;
      });

    const service = {
      request,
      paginate,

      listWorkspaces: (query) => paginate<Workspace>("/v1/workspaces", query),
      getWorkspace: (id) => data<Workspace>("GET", `/v1/workspaces/${id}`),
      getCurrentPrincipal: () => data<CurrentPrincipal>("GET", "/v1/me"),
      listRegions: (query) => data<Region[]>("GET", "/v1/regions", { query }),
      listPostgresRegions: () => data<Region[]>("GET", "/v1/regions/postgres"),
      listAccelerateRegions: () =>
        data<Region[]>("GET", "/v1/regions/accelerate"),

      listProjects: (query) => paginate<Project>("/v1/projects", query),
      getProject: (id) => data<Project>("GET", `/v1/projects/${id}`),
      createProject: (input) =>
        data<ProjectCreateResult>("POST", "/v1/projects", { body: input }),
      updateProject: (id, input) =>
        data<Project>("PATCH", `/v1/projects/${id}`, { body: input }),
      deleteProject: (id) => request<void>("DELETE", `/v1/projects/${id}`),
      transferProject: (id, input) =>
        request<void>("POST", `/v1/projects/${id}/transfer`, { body: input }),

      listDatabases: (query) => paginate<Database>("/v1/databases", query),
      listProjectDatabases: (projectId, query) =>
        paginate<Database>(`/v1/projects/${projectId}/databases`, query),
      getDatabase: (id) => data<Database>("GET", `/v1/databases/${id}`),
      createDatabase: (input) =>
        data<DatabaseCreateResult>("POST", "/v1/databases", { body: input }),
      createProjectDatabase: (projectId, input) =>
        data<DatabaseCreateResult>(
          "POST",
          `/v1/projects/${projectId}/databases`,
          { body: input },
        ),
      updateDatabase: (id, input) =>
        data<Database>("PATCH", `/v1/databases/${id}`, { body: input }),
      deleteDatabase: (id) => request<void>("DELETE", `/v1/databases/${id}`),
      listBackups: (databaseId, query) =>
        request<BackupListResponse>(
          "GET",
          `/v1/databases/${databaseId}/backups`,
          { query },
        ),
      restoreDatabase: (targetDatabaseId, input) =>
        data<Database>("POST", `/v1/databases/${targetDatabaseId}/restore`, {
          body: input,
        }),
      getDatabaseUsage: (databaseId, query) =>
        request<DatabaseUsage>("GET", `/v1/databases/${databaseId}/usage`, {
          query,
        }),

      listConnections: (query) =>
        paginate<DatabaseConnection>("/v1/connections", query),
      listDatabaseConnections: (databaseId, query) =>
        paginate<DatabaseConnection>(
          `/v1/databases/${databaseId}/connections`,
          query,
        ),
      getConnection: (id) =>
        data<DatabaseConnection>("GET", `/v1/connections/${id}`),
      createConnection: (input) =>
        data<DatabaseConnectionWithSecrets>("POST", "/v1/connections", {
          body: input,
        }),
      createDatabaseConnection: (databaseId, input) =>
        data<DatabaseConnectionWithSecrets>(
          "POST",
          `/v1/databases/${databaseId}/connections`,
          { body: input },
        ),
      deleteConnection: (id) =>
        request<void>("DELETE", `/v1/connections/${id}`),
      rotateConnection: (id) =>
        data<DatabaseConnectionWithSecrets>(
          "POST",
          `/v1/connections/${id}/rotate`,
        ),

      listBranches: (projectId, query) =>
        paginate<Branch>(`/v1/projects/${projectId}/branches`, query),
      getBranch: (id) => data<Branch>("GET", `/v1/branches/${id}`),
      createBranch: (projectId, input) =>
        data<Branch>("POST", `/v1/projects/${projectId}/branches`, {
          body: input,
        }),
      updateBranch: (id, input) =>
        data<Branch>("PATCH", `/v1/branches/${id}`, { body: input }),
      deleteBranch: (id) => request<void>("DELETE", `/v1/branches/${id}`),

      listComputeServices: (query) =>
        paginate<ComputeService>("/v1/compute-services", query),
      listProjectComputeServices: (projectId, query) =>
        paginate<ComputeService>(
          `/v1/projects/${projectId}/compute-services`,
          query,
        ),
      getComputeService: (id) =>
        data<ComputeService>("GET", `/v1/compute-services/${id}`),
      createComputeService: (input) =>
        data<ComputeService>("POST", "/v1/compute-services", { body: input }),
      createProjectComputeService: (projectId, input) =>
        data<ComputeService>(
          "POST",
          `/v1/projects/${projectId}/compute-services`,
          { body: input },
        ),
      updateComputeService: (id, input) =>
        data<ComputeService>("PATCH", `/v1/compute-services/${id}`, {
          body: input,
        }),
      deleteComputeService: (id) =>
        request<void>("DELETE", `/v1/compute-services/${id}`),
      promoteComputeService: (id, versionId) =>
        data<PromoteComputeServiceResult>(
          "POST",
          `/v1/compute-services/${id}/promote`,
          { body: { versionId } },
        ),
      rollbackComputeService: (id, versionId) =>
        data<RollbackComputeServiceResult>(
          "POST",
          `/v1/compute-services/${id}/rollback`,
          { body: { versionId } },
        ),
      listComputeServiceDomains: (computeServiceId) =>
        paginate<ApiCustomDomain>(
          `/v1/compute-services/${computeServiceId}/domains`,
        ).pipe(Effect.map((domains) => domains.map(normalizeCustomDomain))),
      createComputeServiceDomain: (computeServiceId, input) =>
        data<ApiCustomDomain>(
          "POST",
          `/v1/compute-services/${computeServiceId}/domains`,
          { body: input },
        ).pipe(Effect.map(normalizeCustomDomain)),
      getCustomDomain: (id) =>
        data<ApiCustomDomain>("GET", `/v1/domains/${id}`).pipe(
          Effect.map(normalizeCustomDomain),
        ),
      deleteCustomDomain: (id) => request<void>("DELETE", `/v1/domains/${id}`),
      retryCustomDomain: (id) =>
        data<ApiCustomDomain>("POST", `/v1/domains/${id}/retry`).pipe(
          Effect.map(normalizeCustomDomain),
        ),

      listComputeVersions: (query) =>
        paginate<ComputeVersionListItem>("/v1/versions", query),
      listServiceComputeVersions: (computeServiceId, query) =>
        paginate<ComputeVersionListItem>(
          `/v1/compute-services/${computeServiceId}/versions`,
          query,
        ),
      getComputeVersion: (id) =>
        data<ComputeVersion>("GET", `/v1/versions/${id}`),
      createComputeVersion: (input) =>
        data<ComputeVersionCreateResult>("POST", "/v1/versions", {
          body: input,
        }),
      createServiceComputeVersion: (computeServiceId, input) =>
        data<ComputeVersionCreateResult>(
          "POST",
          `/v1/compute-services/${computeServiceId}/versions`,
          { body: input },
        ),
      deleteComputeVersion: (id) =>
        request<void>("DELETE", `/v1/versions/${id}`),
      startComputeVersion: (id) =>
        data<StartComputeVersionResult>("POST", `/v1/versions/${id}/start`),
      stopComputeVersion: (id) =>
        request<void>("POST", `/v1/versions/${id}/stop`),
      getComputeServiceVersion: (id) =>
        data<ComputeVersion>("GET", `/v1/compute-services/versions/${id}`),
      deleteComputeServiceVersion: (id) =>
        request<void>("DELETE", `/v1/compute-services/versions/${id}`),
      startComputeServiceVersion: (id) =>
        data<StartComputeVersionResult>(
          "POST",
          `/v1/compute-services/versions/${id}/start`,
        ),
      stopComputeServiceVersion: (id) =>
        request<void>("POST", `/v1/compute-services/versions/${id}/stop`),
      getComputeVersionLogsRequest: (id, query) =>
        buildWebSocketUrl(
          `/v1/compute-services/versions/${id}/logs`,
          logsQuery(query),
        ).pipe(
          Effect.map(
            (url): ComputeVersionLogsRequest => ({
              url,
              headers: {
                Authorization: Redacted.make(
                  `Bearer ${Redacted.value(env.serviceToken)}`,
                ),
              },
            }),
          ),
        ),
      getComputeVersionLogsUrl: (id, query) =>
        buildWebSocketUrl(
          `/v1/compute-services/versions/${id}/logs`,
          logsQuery(query),
        ),

      listApps: (query) => paginate<App>("/v1/apps", query),
      getApp: (id) => data<App>("GET", `/v1/apps/${id}`),
      createApp: (input) => data<App>("POST", "/v1/apps", { body: input }),
      updateApp: (id, input) =>
        data<App>("PATCH", `/v1/apps/${id}`, { body: input }),
      deleteApp: (id) => request<void>("DELETE", `/v1/apps/${id}`),
      promoteApp: (id, target) =>
        data<PromoteAppResult>("POST", `/v1/apps/${id}/promote`, {
          body: target,
        }),
      rollbackApp: (id, target) =>
        data<RollbackAppResult>("POST", `/v1/apps/${id}/rollback`, {
          body: target,
        }),
      listAppDomains: (appId) =>
        paginate<ApiCustomDomain>(`/v1/apps/${appId}/domains`).pipe(
          Effect.map((domains) => domains.map(normalizeCustomDomain)),
        ),
      createAppDomain: (appId, input) =>
        data<ApiCustomDomain>("POST", `/v1/apps/${appId}/domains`, {
          body: input,
        }).pipe(Effect.map(normalizeCustomDomain)),
      listAppDeployments: (appId, query) =>
        paginate<DeploymentListItem>(`/v1/apps/${appId}/deployments`, query),
      createAppDeployment: (appId, input) =>
        data<DeploymentCreateResult>("POST", `/v1/apps/${appId}/deployments`, {
          body: input,
        }),
      getDeployment: (id) => data<Deployment>("GET", `/v1/deployments/${id}`),
      deleteDeployment: (id) =>
        request<void>("DELETE", `/v1/deployments/${id}`),
      startDeployment: (id) =>
        data<StartDeploymentResult>("POST", `/v1/deployments/${id}/start`),
      stopDeployment: (id) =>
        request<void>("POST", `/v1/deployments/${id}/stop`),
      getDeploymentLogsUrl: (id, query) =>
        buildWebSocketUrl(`/v1/deployments/${id}/logs`, logsQuery(query)),
      getBuildLogsUrl: (buildId, query) =>
        buildWebSocketUrl(`/v1/builds/${buildId}/logs`, logsQuery(query)),

      listEnvironmentVariables: (query) =>
        paginate<EnvironmentVariable>("/v1/environment-variables", query),
      getEnvironmentVariable: (id) =>
        data<EnvironmentVariable>("GET", `/v1/environment-variables/${id}`),
      createEnvironmentVariable: (input) =>
        data<EnvironmentVariable>("POST", "/v1/environment-variables", {
          body: input,
        }),
      updateEnvironmentVariable: (id, input) =>
        data<EnvironmentVariable>("PATCH", `/v1/environment-variables/${id}`, {
          body: input,
        }),
      deleteEnvironmentVariable: (id) =>
        request<void>("DELETE", `/v1/environment-variables/${id}`),

      listIntegrations: (query) =>
        paginate<Integration>("/v1/integrations", query),
      listWorkspaceIntegrations: (workspaceId, query) =>
        paginate<Integration>(
          `/v1/workspaces/${workspaceId}/integrations`,
          query,
        ),
      getIntegration: (id) =>
        data<Integration>("GET", `/v1/integrations/${id}`),
      deleteIntegration: (id) =>
        request<void>("DELETE", `/v1/integrations/${id}`),
      revokeWorkspaceIntegration: (workspaceId, clientId) =>
        request<void>(
          "DELETE",
          `/v1/workspaces/${workspaceId}/integrations/${clientId}`,
        ),

      listScmInstallations: (query) =>
        paginate<ScmInstallation>("/v1/scm-installations", query),
      createScmInstallIntent: (input) =>
        data<ScmInstallIntent>(
          "POST",
          "/v1/scm-installations/install-intents",
          {
            body: input,
          },
        ),
      connectScmInstallation: (installationId, input) =>
        data<ScmInstallation>(
          "POST",
          `/v1/scm-installations/${installationId}/connect`,
          { body: input },
        ),
      listScmInstallationRepositories: (installationId, query) =>
        paginate<ScmRepository>(
          `/v1/scm-installations/${installationId}/repositories`,
          query,
        ),

      listSourceRepositories: (query) =>
        paginate<SourceRepository>("/v1/source-repositories", query),
      getSourceRepository: (id) =>
        data<SourceRepository>("GET", `/v1/source-repositories/${id}`),
      createSourceRepository: (input) =>
        data<SourceRepository>("POST", "/v1/source-repositories", {
          body: input,
        }),
      deleteSourceRepository: (id) =>
        request<void>("DELETE", `/v1/source-repositories/${id}`),
    } satisfies PrismaManagementClient;
    return service;
  });
}

const parseErrorMessage = (body: string): string | undefined => {
  if (body.length === 0) return undefined;
  try {
    const json = JSON.parse(body) as {
      message?: string;
      error?: string | { message?: string };
      errors?: Array<{ message?: string }>;
    };
    if (typeof json.message === "string") return json.message;
    if (typeof json.error === "string") return json.error;
    if (typeof json.error?.message === "string") return json.error.message;
    const first = json.errors?.find((e) => typeof e.message === "string");
    if (first?.message) return first.message;
  } catch {
    return body;
  }
  return undefined;
};

export const PrismaClientLive = Layer.effect(PrismaClient, makePrismaClient());
