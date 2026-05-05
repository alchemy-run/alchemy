import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import type { HttpMethod } from "effect/unstable/http/HttpMethod";
import { Credentials } from "./Credentials.ts";

/**
 * Direct HTTP client wrappers for Neon Console API endpoints.
 *
 * The generated `@distilled.cloud/neon` SDK doesn't expose typed input
 * schemas for the `branch` / `endpoints` body fields on
 * `createProjectBranch`, so we issue typed requests manually here while
 * still reusing the SDK's `Credentials` service.
 */

export class NeonApiError extends Data.TaggedError("NeonApiError")<{
  status: number;
  method: string;
  url: string;
  message: string;
  code?: string;
  body?: unknown;
}> {}

export class ProjectNotFound extends Data.TaggedError("ProjectNotFound")<{
  projectId?: string;
  name?: string;
}> {}

export class BranchNotFound extends Data.TaggedError("BranchNotFound")<{
  projectId: string;
  branchId?: string;
  name?: string;
}> {}

export type NeonOperationStatus =
  | "scheduling"
  | "running"
  | "finished"
  | "failed"
  | "error"
  | "cancelling"
  | "cancelled"
  | "skipped";

export interface NeonOperation {
  id: string;
  project_id: string;
  branch_id?: string;
  endpoint_id?: string;
  action: string;
  status: NeonOperationStatus;
  error?: string;
  failures_count: number;
  retry_at?: string;
  created_at: string;
  updated_at: string;
  total_duration_ms: number;
}

export interface NeonProjectInfo {
  id: string;
  name: string;
  region_id: string;
  pg_version: number;
  proxy_host: string;
  default_endpoint_settings?: Record<string, unknown>;
  settings?: Record<string, unknown>;
  history_retention_seconds: number;
  created_at: string;
  updated_at: string;
}

export interface NeonBranchInfo {
  id: string;
  project_id: string;
  parent_id?: string;
  parent_lsn?: string;
  parent_timestamp?: string;
  name: string;
  current_state: string;
  default: boolean;
  protected: boolean;
  created_at: string;
  updated_at: string;
  expires_at?: string;
  init_source?: string;
}

export interface NeonEndpointInfo {
  id: string;
  host: string;
  project_id: string;
  branch_id: string;
  type: "read_only" | "read_write";
  current_state: string;
  pooler_enabled: boolean;
  pooler_mode?: string;
  proxy_host: string;
  created_at: string;
  updated_at: string;
}

export interface NeonDatabaseInfo {
  id: number;
  branch_id: string;
  name: string;
  owner_name: string;
  created_at: string;
  updated_at: string;
}

export interface NeonRoleInfo {
  branch_id: string;
  name: string;
  password?: string;
  protected?: boolean;
  created_at: string;
  updated_at: string;
}

export interface NeonConnectionUriInfo {
  connection_uri: string;
  connection_parameters: {
    database: string;
    password: string;
    role: string;
    host: string;
    pooler_host: string;
  };
}

export interface CreateProjectInput {
  name?: string;
  region_id?: string;
  pg_version?: number;
  default_branch_name?: string;
  default_branch?: {
    name?: string;
    role_name?: string;
    database_name?: string;
  };
  history_retention_seconds?: number;
  org_id?: string;
}

export interface CreateProjectOutput {
  project: NeonProjectInfo;
  branch: NeonBranchInfo;
  endpoints: NeonEndpointInfo[];
  databases: NeonDatabaseInfo[];
  roles: NeonRoleInfo[];
  connection_uris: NeonConnectionUriInfo[];
  operations: NeonOperation[];
}

export interface UpdateProjectInput {
  name?: string;
  history_retention_seconds?: number;
  default_endpoint_settings?: Record<string, unknown>;
  settings?: Record<string, unknown>;
}

export interface CreateBranchEndpoint {
  type: "read_only" | "read_write";
  autoscaling_limit_min_cu?: number;
  autoscaling_limit_max_cu?: number;
  suspend_timeout_seconds?: number;
}

export interface CreateBranchInput {
  name?: string;
  parent_id?: string;
  parent_lsn?: string;
  parent_timestamp?: string;
  init_source?: "schema-only" | "parent-data";
  protected?: boolean;
  expires_at?: string;
}

export interface CreateBranchOutput {
  branch: NeonBranchInfo;
  endpoints: NeonEndpointInfo[];
  databases: NeonDatabaseInfo[];
  roles: NeonRoleInfo[];
  connection_uris?: NeonConnectionUriInfo[];
  operations: NeonOperation[];
}

const request = <A>(
  method: HttpMethod,
  path: string,
  body?: unknown,
): Effect.Effect<A, NeonApiError, Credentials | HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const creds = yield* Credentials;
    const client = yield* HttpClient.HttpClient;
    const url = `${creds.apiBaseUrl}${path}`;

    let req = HttpClientRequest.make(method)(url).pipe(
      HttpClientRequest.setHeader(
        "Authorization",
        `Bearer ${Redacted.value(creds.apiKey)}`,
      ),
      HttpClientRequest.setHeader("Accept", "application/json"),
    );
    if (body !== undefined) {
      req = yield* HttpClientRequest.bodyJson(body)(req).pipe(
        Effect.mapError(
          (e) =>
            new NeonApiError({
              status: 0,
              method,
              url,
              message: `Failed to serialize body: ${String(e)}`,
            }),
        ),
      );
    }
    const response = yield* client.execute(req).pipe(
      Effect.scoped,
      Effect.mapError(
        (e) =>
          new NeonApiError({
            status: 0,
            method,
            url,
            message: `Network error: ${String(e)}`,
          }),
      ),
    );
    if (response.status === 204) {
      return undefined as A;
    }
    const text = yield* response.text.pipe(
      Effect.mapError(
        (e) =>
          new NeonApiError({
            status: response.status,
            method,
            url,
            message: `Failed to read response body: ${String(e)}`,
          }),
      ),
    );
    let parsed: unknown;
    try {
      parsed = text.length > 0 ? JSON.parse(text) : undefined;
    } catch {
      parsed = text;
    }
    if (response.status >= 400) {
      const message =
        (typeof parsed === "object" &&
          parsed != null &&
          (parsed as { message?: string }).message) ||
        `HTTP ${response.status}`;
      const code =
        typeof parsed === "object" && parsed != null
          ? (parsed as { code?: string }).code
          : undefined;
      return yield* new NeonApiError({
        status: response.status,
        method,
        url,
        message,
        code,
        body: parsed,
      });
    }
    return parsed as A;
  });

export const createProject = (input: CreateProjectInput) =>
  request<CreateProjectOutput>("POST", "/projects", {
    project: {
      name: input.name,
      region_id: input.region_id,
      pg_version: input.pg_version,
      branch:
        input.default_branch ??
        (input.default_branch_name
          ? { name: input.default_branch_name }
          : undefined),
      history_retention_seconds: input.history_retention_seconds,
      org_id: input.org_id,
    },
  });

export const getProject = (
  projectId: string,
): Effect.Effect<
  { project: NeonProjectInfo },
  NeonApiError | ProjectNotFound,
  Credentials | HttpClient.HttpClient
> =>
  request<{ project: NeonProjectInfo }>(
    "GET",
    `/projects/${encodeURIComponent(projectId)}`,
  ).pipe(
    Effect.catchTag(
      "NeonApiError",
      (e): Effect.Effect<never, NeonApiError | ProjectNotFound> =>
        e.status === 404
          ? Effect.fail(new ProjectNotFound({ projectId }))
          : Effect.fail(e),
    ),
  );

export const updateProject = (projectId: string, input: UpdateProjectInput) =>
  request<{ project: NeonProjectInfo }>(
    "PATCH",
    `/projects/${encodeURIComponent(projectId)}`,
    { project: input },
  );

export const deleteProject = (projectId: string) =>
  request<{ project: NeonProjectInfo }>(
    "DELETE",
    `/projects/${encodeURIComponent(projectId)}`,
  ).pipe(
    Effect.catchTag("NeonApiError", (e) =>
      e.status === 404 ? Effect.void : Effect.fail(e),
    ),
  );

export interface ListProjectsResult {
  projects: NeonProjectInfo[];
  pagination?: { next?: string };
}

export const listProjects = (
  params: { search?: string; cursor?: string } = {},
) => {
  const q = new URLSearchParams();
  if (params.search) q.set("search", params.search);
  if (params.cursor) q.set("cursor", params.cursor);
  const qs = q.toString();
  return request<ListProjectsResult>("GET", `/projects${qs ? `?${qs}` : ""}`);
};

export const findProjectByName = (name: string) =>
  Effect.gen(function* () {
    const matches: NeonProjectInfo[] = [];
    let cursor: string | undefined;
    do {
      const page = yield* listProjects({ search: name, cursor });
      for (const p of page.projects) {
        if (p.name === name) matches.push(p);
      }
      cursor = page.pagination?.next;
    } while (cursor);
    return matches;
  });

export const createProjectBranch = (
  projectId: string,
  input: CreateBranchInput & { endpoints?: CreateBranchEndpoint[] },
) =>
  request<CreateBranchOutput>(
    "POST",
    `/projects/${encodeURIComponent(projectId)}/branches`,
    {
      branch: {
        name: input.name,
        parent_id: input.parent_id,
        parent_lsn: input.parent_lsn,
        parent_timestamp: input.parent_timestamp,
        init_source: input.init_source,
        protected: input.protected,
        expires_at: input.expires_at,
      },
      endpoints: input.endpoints ?? [],
    },
  );

export const getProjectBranch = (
  projectId: string,
  branchId: string,
): Effect.Effect<
  { branch: NeonBranchInfo },
  NeonApiError | BranchNotFound,
  Credentials | HttpClient.HttpClient
> =>
  request<{ branch: NeonBranchInfo }>(
    "GET",
    `/projects/${encodeURIComponent(projectId)}/branches/${encodeURIComponent(branchId)}`,
  ).pipe(
    Effect.catchTag(
      "NeonApiError",
      (e): Effect.Effect<never, NeonApiError | BranchNotFound> =>
        e.status === 404
          ? Effect.fail(new BranchNotFound({ projectId, branchId }))
          : Effect.fail(e),
    ),
  );

export const updateProjectBranch = (
  projectId: string,
  branchId: string,
  input: { name?: string; protected?: boolean; expires_at?: string | null },
) =>
  request<{ branch: NeonBranchInfo }>(
    "PATCH",
    `/projects/${encodeURIComponent(projectId)}/branches/${encodeURIComponent(branchId)}`,
    { branch: input },
  );

export const deleteProjectBranch = (projectId: string, branchId: string) =>
  request<{ branch: NeonBranchInfo }>(
    "DELETE",
    `/projects/${encodeURIComponent(projectId)}/branches/${encodeURIComponent(branchId)}`,
  ).pipe(
    Effect.catchTag("NeonApiError", (e) =>
      e.status === 404 ? Effect.void : Effect.fail(e),
    ),
  );

export interface ListBranchesResult {
  branches: NeonBranchInfo[];
  pagination?: { next?: string };
}

export const listProjectBranches = (
  projectId: string,
  params: { search?: string; cursor?: string } = {},
) => {
  const q = new URLSearchParams();
  if (params.search) q.set("search", params.search);
  if (params.cursor) q.set("cursor", params.cursor);
  const qs = q.toString();
  return request<ListBranchesResult>(
    "GET",
    `/projects/${encodeURIComponent(projectId)}/branches${qs ? `?${qs}` : ""}`,
  );
};

export const findBranchByName = (projectId: string, name: string) =>
  Effect.gen(function* () {
    const matches: NeonBranchInfo[] = [];
    let cursor: string | undefined;
    do {
      const page = yield* listProjectBranches(projectId, {
        search: name,
        cursor,
      });
      for (const b of page.branches) {
        if (b.name === name) matches.push(b);
      }
      cursor = page.pagination?.next;
    } while (cursor);
    return matches;
  });

export const listProjectBranchEndpoints = (
  projectId: string,
  branchId: string,
) =>
  request<{ endpoints: NeonEndpointInfo[] }>(
    "GET",
    `/projects/${encodeURIComponent(projectId)}/branches/${encodeURIComponent(branchId)}/endpoints`,
  );

export const listProjectBranchDatabases = (
  projectId: string,
  branchId: string,
) =>
  request<{ databases: NeonDatabaseInfo[] }>(
    "GET",
    `/projects/${encodeURIComponent(projectId)}/branches/${encodeURIComponent(branchId)}/databases`,
  );

export const listProjectBranchRoles = (projectId: string, branchId: string) =>
  request<{ roles: NeonRoleInfo[] }>(
    "GET",
    `/projects/${encodeURIComponent(projectId)}/branches/${encodeURIComponent(branchId)}/roles`,
  );

export const getConnectionUri = (
  projectId: string,
  params: {
    branch_id: string;
    database_name: string;
    role_name: string;
    pooled?: boolean;
  },
) => {
  const q = new URLSearchParams();
  q.set("branch_id", params.branch_id);
  q.set("database_name", params.database_name);
  q.set("role_name", params.role_name);
  if (params.pooled !== undefined) q.set("pooled", String(params.pooled));
  return request<{ uri: string }>(
    "GET",
    `/projects/${encodeURIComponent(projectId)}/connection_uri?${q.toString()}`,
  );
};

export const getProjectOperation = (projectId: string, operationId: string) =>
  request<{ operation: NeonOperation }>(
    "GET",
    `/projects/${encodeURIComponent(projectId)}/operations/${encodeURIComponent(operationId)}`,
  );

const isOperationComplete = (op: NeonOperation): boolean =>
  ["finished", "failed", "error", "cancelled", "skipped"].includes(op.status);

export class OperationFailed extends Data.TaggedError("OperationFailed")<{
  operationId: string;
  action: string;
  status: NeonOperationStatus;
  error?: string;
}> {}

class OperationPending extends Data.TaggedError("OperationPending")<{
  operationId: string;
}> {}

/**
 * Wait for the given operations to reach a terminal state. Polls every
 * 500ms with exponential backoff up to ~30s per operation.
 */
export const waitForOperations = (operations: ReadonlyArray<NeonOperation>) =>
  Effect.gen(function* () {
    for (const op of operations) {
      if (isOperationComplete(op)) {
        if (op.status === "failed" || op.status === "error") {
          return yield* new OperationFailed({
            operationId: op.id,
            action: op.action,
            status: op.status,
            error: op.error,
          });
        }
        continue;
      }
      yield* getProjectOperation(op.project_id, op.id).pipe(
        Effect.flatMap(
          ({
            operation,
          }): Effect.Effect<void, OperationFailed | OperationPending> => {
            if (operation.status === "failed" || operation.status === "error") {
              return Effect.fail(
                new OperationFailed({
                  operationId: operation.id,
                  action: operation.action,
                  status: operation.status,
                  error: operation.error,
                }),
              );
            }
            if (!isOperationComplete(operation)) {
              return Effect.fail(new OperationPending({ operationId: op.id }));
            }
            return Effect.void;
          },
        ),
        Effect.retry({
          while: (e: unknown) =>
            (e as { _tag?: string })._tag === "OperationPending" ||
            (e as { _tag?: string })._tag === "NeonApiError",
          schedule: Schedule.both(
            Schedule.exponential(Duration.millis(500), 1.5),
            Schedule.recurs(60),
          ),
        }),
        Effect.catchTag("OperationPending", () => Effect.void),
        Effect.catchTag("NeonApiError", (e) =>
          Effect.die(`Failed to poll Neon operation: ${e.message}`),
        ),
      );
    }
  });
