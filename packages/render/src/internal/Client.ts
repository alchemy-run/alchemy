import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { RenderCredentials } from "../Credentials.ts";
import {
  RenderBadRequestError,
  RenderConflictError,
  RenderForbiddenError,
  RenderGoneError,
  RenderNotAcceptableError,
  RenderNotFoundError,
  RenderOwnerResolutionError,
  RenderPaymentRequiredError,
  RenderRateLimitError,
  RenderSchemaError,
  RenderServerError,
  RenderTransportError,
  RenderUnauthorizedError,
  RenderUnprocessableEntityError,
  type RenderApiError,
} from "../Errors.ts";
import {
  VoidResponseSchema,
  WireBlueprintDetailSchema,
  WireBlueprintSchema,
  WireBlueprintSyncWithCursorSchema,
  WireBlueprintValidateResponseSchema,
  WireBlueprintWithCursorSchema,
  WireCustomDomainListSchema,
  WireCustomDomainWithCursorSchema,
  WireDedicatedIpListSchema,
  WireDedicatedIpSchema,
  WireDeployCreateResponseSchema,
  WireDeployWithCursorSchema,
  WireDiskDetailsSchema,
  WireDiskWithCursorSchema,
  WireEnvGroupSchema,
  WireEnvGroupWithCursorSchema,
  WireEnvVarWithCursorListSchema,
  WireEnvVarWithCursorSchema,
  WireEnvironmentSchema,
  WireEnvironmentWithCursorSchema,
  WireHeaderListSchema,
  WireHeaderWithCursorSchema,
  WireKeyValueConnectionInfoSchema,
  WireKeyValueSchema,
  WireKeyValueWithCursorSchema,
  WireLogsResponseSchema,
  WireMetricsStreamSchema,
  WireNotificationOverrideSchema,
  WireNotificationSettingSchema,
  WireOwnerLogStreamSettingSchema,
  WireOwnerWithCursorSchema,
  WirePostgresConnectionInfoSchema,
  WirePostgresExportListSchema,
  WirePostgresExportSchema,
  WirePostgresRecoveryInfoSchema,
  WirePostgresSchema,
  WirePostgresWithCursorSchema,
  WireProjectSchema,
  WireProjectWithCursorSchema,
  WireRedisConnectionInfoSchema,
  WireRedisSchema,
  WireRedisWithCursorSchema,
  WireRegistryCredentialListSchema,
  WireRegistryCredentialSchema,
  WireResourceLogStreamSettingSchema,
  WireRouteListSchema,
  WireRouteWithCursorSchema,
  WireSecretFileWithCursorListSchema,
  WireSecretFileWithCursorSchema,
  WireServiceAndDeploySchema,
  WireServiceSchema,
  WireServiceWithCursorSchema,
  WireTaskRunSchema,
  WireTaskRunWithCursorSchema,
  WireWebhookSchema,
  WireWebhookWithCursorSchema,
  WireWorkflowSchema,
  WireWorkflowVersionSchema,
  WireWorkflowVersionWithCursorSchema,
  WireWorkflowWithCursorSchema,
  nullableArray,
} from "./Schemas.ts";
import type {
  WireBlueprint,
  WireBlueprintSync,
  WireDeploy,
  WireDiskDetails,
  WireEnvGroupMeta,
  WireEnvVar,
  WireEnvironment,
  WireEnvironmentCreateInput,
  WireEnvironmentUpdateInput,
  WireKeyValue,
  WireOwner,
  WirePostgres,
  WireProject,
  WireProjectCreateInput,
  WireRedis,
  WireRegistryCredentialCreateInput,
  WireRegistryCredentialUpdateInput,
  WireSecretFile,
  WireService,
  WireTaskRun,
  WireWebhook,
  WireWorkflow,
  WireWorkflowVersion,
  WireCustomDomain,
  WireHeader,
  WireRoute,
  WireEnvGroupCreateInput,
  WireEnvVarInput,
} from "./WireTypes.ts";

export type QueryValue = string | number | boolean | ReadonlyArray<string> | undefined;

export interface RequestOptions<T> {
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly path: string;
  readonly query?: Record<string, QueryValue>;
  readonly body?: unknown;
  readonly schema: Schema.Decoder<T>;
}

const MAX_RATE_LIMIT_RETRY_WAIT_SECONDS = 25;

const isRetryableApiError = (error: unknown): boolean =>
  (error instanceof RenderRateLimitError &&
    (error.retryAfterSeconds === undefined ||
      error.retryAfterSeconds <= MAX_RATE_LIMIT_RETRY_WAIT_SECONDS)) ||
  error instanceof RenderServerError ||
  error instanceof RenderTransportError;

const retrySchedule = Schedule.exponential(Duration.millis(150)).pipe(Schedule.jittered);

const buildUrl = (baseUrl: string, path: string, query?: Record<string, QueryValue>): string => {
  const cleanBase = baseUrl.replace(/\/+$/, "");
  const cleanPath = path.startsWith("/") ? path : `/${path}`;
  const url = `${cleanBase}${cleanPath}`;
  if (!query) return url;
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        search.append(key, item);
      }
    } else {
      search.append(key, String(value));
    }
  }
  const qs = search.toString();
  return qs.length > 0 ? `${url}?${qs}` : url;
};

interface ErrorEnvelope {
  readonly id?: string;
  readonly message?: string;
  readonly error?: string;
}

const parseJsonSafe = (text: string): ErrorEnvelope | undefined => {
  if (text.trim().length === 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null) {
      return parsed as ErrorEnvelope;
    }
    return undefined;
  } catch {
    return undefined;
  }
};

const parseHeaderSeconds = (raw: string | undefined): number | undefined => {
  if (!raw) return undefined;
  const parsed = Number(raw.trim());
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  // Support both delta-seconds and epoch-seconds reset headers.
  return parsed > 1_000_000_000 ? Math.max(0, Math.ceil(parsed - Date.now() / 1_000)) : parsed;
};

const parseRetryAfterSeconds = (headers: Record<string, string>): number | undefined => {
  const retryAfter = parseHeaderSeconds(headers["retry-after"] ?? headers["Retry-After"]);
  if (retryAfter !== undefined) return retryAfter;
  return parseHeaderSeconds(
    headers["ratelimit-reset"] ??
      headers["RateLimit-Reset"] ??
      headers["x-ratelimit-reset"] ??
      headers["X-RateLimit-Reset"],
  );
};

const mapStatusError = (
  status: number,
  method: string,
  path: string,
  text: string,
  headers: Record<string, string>,
): RenderApiError => {
  const parsed = parseJsonSafe(text);
  const message =
    parsed?.message ??
    parsed?.error ??
    (text.trim().length > 0 ? text.trim() : `Render API ${method} ${path} failed (${status})`);
  const code = parsed?.id;
  switch (status) {
    case 400:
      return new RenderBadRequestError({ status: 400, method, path, code, message });
    case 401:
      return new RenderUnauthorizedError({ status: 401, method, path, code, message });
    case 402:
      return new RenderPaymentRequiredError({ status: 402, method, path, code, message });
    case 403:
      return new RenderForbiddenError({ status: 403, method, path, code, message });
    case 404:
      return new RenderNotFoundError({ status: 404, method, path, code, message });
    case 406:
      return new RenderNotAcceptableError({ status: 406, method, path, code, message });
    case 409:
      return new RenderConflictError({ status: 409, method, path, code, message });
    case 410:
      return new RenderGoneError({ status: 410, method, path, code, message });
    case 422:
      return new RenderUnprocessableEntityError({ status: 422, method, path, code, message });
    case 429: {
      const retryAfterSeconds = parseRetryAfterSeconds(headers);
      const rateLimitMessage =
        retryAfterSeconds !== undefined
          ? `${message} (retry after ${retryAfterSeconds}s)`
          : message;
      return new RenderRateLimitError({
        status: 429,
        method,
        path,
        retryAfterSeconds,
        message: rateLimitMessage,
      });
    }
    default:
      if (status >= 500) {
        return new RenderServerError({ status, method, path, code, message });
      }
      return new RenderTransportError({ method, path, message });
  }
};

const makeHttpRequest = (
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  url: string,
  token: string,
  body?: unknown,
  formData?: FormData,
): HttpClientRequest.HttpClientRequest => {
  const base =
    method === "GET"
      ? HttpClientRequest.get(url)
      : method === "POST"
        ? HttpClientRequest.post(url)
        : method === "PUT"
          ? HttpClientRequest.put(url)
          : method === "PATCH"
            ? HttpClientRequest.patch(url)
            : HttpClientRequest.delete(url);
  const authed = base.pipe(
    HttpClientRequest.bearerToken(token),
    HttpClientRequest.setHeader("Accept", "application/json"),
  );
  if (formData !== undefined) {
    return authed.pipe(HttpClientRequest.bodyFormData(formData));
  }
  if (body === undefined) {
    return authed;
  }
  return authed.pipe(HttpClientRequest.bodyJsonUnsafe(body));
};

const executeValidatedRequest = <T>(options: {
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly path: string;
  readonly query?: Record<string, QueryValue>;
  readonly body?: unknown;
  readonly formData?: FormData;
  readonly schema?: Schema.Decoder<T>;
}): Effect.Effect<T, RenderApiError, HttpClient.HttpClient | RenderCredentials> =>
  Effect.gen(function* () {
    const credentialsEffect = yield* RenderCredentials;
    const credentials = yield* credentialsEffect.pipe(
      Effect.mapError(
        (cause) =>
          new RenderUnauthorizedError({
            status: 401,
            method: options.method,
            path: options.path,
            message: cause.message,
          }),
      ),
    );
    const http = yield* HttpClient.HttpClient;
    const url = buildUrl(credentials.apiBaseUrl, options.path, options.query);
    const req = makeHttpRequest(
      options.method,
      url,
      Redacted.value(credentials.apiKey),
      options.body,
      options.formData,
    );

    const attempt = Effect.gen(function* () {
      const response = yield* http.execute(req).pipe(
        Effect.mapError(
          (cause) =>
            new RenderTransportError({
              method: options.method,
              path: options.path,
              message: `Render request ${options.method} ${options.path} failed: ${String(cause)}`,
              cause,
            }),
        ),
      );

      const text = yield* response.text.pipe(
        Effect.mapError(
          (cause) =>
            new RenderTransportError({
              method: options.method,
              path: options.path,
              message: `Failed reading Render response body for ${options.method} ${options.path}: ${String(cause)}`,
              cause,
            }),
        ),
      );

      if (response.status < 200 || response.status >= 300) {
        const error = mapStatusError(
          response.status,
          options.method,
          options.path,
          text,
          response.headers,
        );
        if (
          error instanceof RenderRateLimitError &&
          (error.retryAfterSeconds === undefined ||
            error.retryAfterSeconds <= MAX_RATE_LIMIT_RETRY_WAIT_SECONDS)
        ) {
          const waitSeconds = error.retryAfterSeconds !== undefined ? error.retryAfterSeconds : 2;
          if (waitSeconds > 0) {
            yield* Effect.sleep(Duration.seconds(waitSeconds));
          }
        }
        return yield* error;
      }

      if (!options.schema) {
        return undefined as T;
      }

      const rawValue: unknown = yield* Effect.try({
        try: () => (text.trim().length === 0 ? null : JSON.parse(text)),
        catch: (cause) =>
          new RenderTransportError({
            method: options.method,
            path: options.path,
            message: `Invalid JSON response from Render ${options.method} ${options.path}: ${String(cause)}`,
            cause,
          }),
      });

      return yield* Schema.decodeUnknownEffect(options.schema)(rawValue).pipe(
        Effect.mapError(
          (cause) =>
            new RenderSchemaError({
              method: options.method,
              path: options.path,
              message: `Render response schema validation failed for ${options.method} ${options.path}: ${String(cause)}`,
              cause,
            }),
        ),
      );
    });

    return yield* attempt.pipe(
      Effect.retry({
        schedule: retrySchedule,
        times: 3,
        while: isRetryableApiError,
      }),
    );
  });

export const request = <T>(
  options: RequestOptions<T>,
): Effect.Effect<T, RenderApiError, HttpClient.HttpClient | RenderCredentials> =>
  executeValidatedRequest(options);

export const requestVoid = (options: {
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly path: string;
  readonly query?: Record<string, QueryValue>;
  readonly body?: unknown;
}) => executeValidatedRequest<void>({ ...options, schema: VoidResponseSchema });

export const requestMultipart = <T>(options: {
  readonly path: string;
  readonly formData: FormData;
  readonly schema: Schema.Decoder<T>;
}) =>
  executeValidatedRequest<T>({
    method: "POST",
    path: options.path,
    formData: options.formData,
    schema: options.schema,
  });

export const ignoreNotFound = <A, E, R>(
  eff: Effect.Effect<A, E | RenderNotFoundError, R>,
): Effect.Effect<A | undefined, Exclude<E, RenderNotFoundError>, R> =>
  eff.pipe(
    Effect.catchTag("RenderNotFoundError", () => Effect.succeed(undefined)) as (
      e: Effect.Effect<A, E | RenderNotFoundError, R>,
    ) => Effect.Effect<A | undefined, Exclude<E, RenderNotFoundError>, R>,
  );

export const deleteIdempotent = (path: string, query?: Record<string, QueryValue>) =>
  ignoreNotFound(requestVoid({ method: "DELETE", path, query })).pipe(Effect.asVoid);

const DEFAULT_PAGE_LIMIT = 100;

export const paginateCursor = <Row extends { readonly cursor?: string }, Item>(
  path: string,
  baseQuery: Record<string, QueryValue> | undefined,
  rowSchema: Schema.Decoder<Row>,
  extract: (row: Row) => Item | undefined,
): Effect.Effect<Item[], RenderApiError, HttpClient.HttpClient | RenderCredentials> =>
  Effect.gen(function* () {
    const items: Item[] = [];
    const seenCursors = new Set<string>();
    const pageSchema = nullableArray(rowSchema);
    let cursor: string | undefined;

    for (;;) {
      const rows = yield* request<Row[]>({
        method: "GET",
        path,
        query: {
          ...baseQuery,
          limit: DEFAULT_PAGE_LIMIT,
          cursor,
        },
        schema: pageSchema,
      });
      if (rows.length === 0) {
        break;
      }
      for (const row of rows) {
        const extracted = extract(row);
        if (extracted !== undefined) {
          items.push(extracted);
        }
      }
      const nextCursor = rows[rows.length - 1]?.cursor;
      if (!nextCursor || seenCursors.has(nextCursor)) {
        break;
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }

    return items;
  });

export const listOwners = () =>
  paginateCursor<typeof WireOwnerWithCursorSchema.Type, WireOwner>(
    "/owners",
    undefined,
    WireOwnerWithCursorSchema,
    (row) => row.owner,
  );

/**
 * Resolve the target owner/workspace ID from config, or from `GET /owners`
 * when omitted (fails loudly if 0 or multiple owners exist without `ownerId`).
 */
export const resolveOwnerId = (
  explicitOwnerId?: string,
): Effect.Effect<
  string,
  RenderApiError | RenderOwnerResolutionError,
  HttpClient.HttpClient | RenderCredentials
> =>
  Effect.gen(function* () {
    if (explicitOwnerId && explicitOwnerId.trim().length > 0) {
      return explicitOwnerId.trim();
    }
    const credentialsEffect = yield* RenderCredentials;
    const credentials = yield* credentialsEffect.pipe(
      Effect.mapError(
        (cause) =>
          new RenderUnauthorizedError({
            status: 401,
            method: "GET",
            path: "/owners",
            message: cause.message,
          }),
      ),
    );
    if (credentials.ownerId && credentials.ownerId.trim().length > 0) {
      return credentials.ownerId.trim();
    }
    const owners = yield* listOwners();
    if (owners.length === 1) {
      return owners[0].id;
    }
    return yield* new RenderOwnerResolutionError({
      ownerCount: owners.length,
      message:
        owners.length === 0
          ? "No Render workspace or user owners returned by GET /owners. Set RENDER_OWNER_ID or pass ownerId."
          : `Expected 1 Render owner when ownerId is omitted, got ${owners.length} (${owners.map((o) => `${o.name}:${o.id}`).join(", ")}). Set RENDER_OWNER_ID or pass ownerId.`,
    });
  });

// ---- Projects ----
export const listProjects = (query?: { ownerId?: string[] }) =>
  paginateCursor<typeof WireProjectWithCursorSchema.Type, WireProject>(
    "/projects",
    query,
    WireProjectWithCursorSchema,
    (r) => r.project,
  );
export const createProject = (body: WireProjectCreateInput) =>
  request({ method: "POST", path: "/projects", body, schema: WireProjectSchema });
export const getProject = (id: string) =>
  request({
    method: "GET",
    path: `/projects/${encodeURIComponent(id)}`,
    schema: WireProjectSchema,
  });
export const updateProject = (id: string, body: { name?: string }) =>
  request({
    method: "PATCH",
    path: `/projects/${encodeURIComponent(id)}`,
    body,
    schema: WireProjectSchema,
  });
export const deleteProject = (id: string) =>
  deleteIdempotent(`/projects/${encodeURIComponent(id)}`);

// ---- Environments ----
export const listEnvironments = (query?: { projectId?: string[] }) =>
  paginateCursor<typeof WireEnvironmentWithCursorSchema.Type, WireEnvironment>(
    "/environments",
    query,
    WireEnvironmentWithCursorSchema,
    (r) => r.environment,
  );
export const createEnvironment = (body: WireEnvironmentCreateInput) =>
  request({ method: "POST", path: "/environments", body, schema: WireEnvironmentSchema });
export const getEnvironment = (id: string) =>
  request({
    method: "GET",
    path: `/environments/${encodeURIComponent(id)}`,
    schema: WireEnvironmentSchema,
  });
export const updateEnvironment = (id: string, body: WireEnvironmentUpdateInput) =>
  request({
    method: "PATCH",
    path: `/environments/${encodeURIComponent(id)}`,
    body,
    schema: WireEnvironmentSchema,
  });
export const deleteEnvironment = (id: string) =>
  deleteIdempotent(`/environments/${encodeURIComponent(id)}`);

export const addResourcesToEnvironment = (environmentId: string, resourceIds: string[]) =>
  request({
    method: "POST",
    path: `/environments/${encodeURIComponent(environmentId)}/resources`,
    body: { resourceIds },
    schema: WireEnvironmentSchema,
  });

export const removeResourcesFromEnvironment = (environmentId: string, resourceIds: string[]) =>
  requestVoid({
    method: "DELETE",
    path: `/environments/${encodeURIComponent(environmentId)}/resources`,
    query: { resourceIds },
  });

/**
 * Synchronize a resource's Render environment membership: remove from the
 * previous environment (if changed) and add to the desired environment.
 */
export const syncResourceEnvironment = (
  resourceId: string,
  currentEnvironmentId: string | undefined,
  desiredEnvironmentId: string | undefined,
): Effect.Effect<string | undefined, RenderApiError, HttpClient.HttpClient | RenderCredentials> =>
  Effect.gen(function* () {
    const current =
      currentEnvironmentId && currentEnvironmentId.length > 0 ? currentEnvironmentId : undefined;
    const desired =
      desiredEnvironmentId && desiredEnvironmentId.length > 0 ? desiredEnvironmentId : undefined;
    if (current === desired) {
      return desired;
    }
    if (current !== undefined) {
      yield* ignoreNotFound(removeResourcesFromEnvironment(current, [resourceId]));
    }
    if (desired !== undefined) {
      const updated = yield* addResourcesToEnvironment(desired, [resourceId]);
      return updated?.id ?? desired;
    }
    return undefined;
  });

// ---- Registry Credentials ----
export const listRegistryCredentials = (query?: { ownerId?: string[] }) =>
  request({
    method: "GET",
    path: "/registrycredentials",
    query,
    schema: WireRegistryCredentialListSchema,
  });
export const createRegistryCredential = (body: WireRegistryCredentialCreateInput) =>
  request({
    method: "POST",
    path: "/registrycredentials",
    body,
    schema: WireRegistryCredentialSchema,
  });
export const getRegistryCredential = (id: string) =>
  request({
    method: "GET",
    path: `/registrycredentials/${encodeURIComponent(id)}`,
    schema: WireRegistryCredentialSchema,
  });
export const updateRegistryCredential = (id: string, body: WireRegistryCredentialUpdateInput) =>
  request({
    method: "PATCH",
    path: `/registrycredentials/${encodeURIComponent(id)}`,
    body,
    schema: WireRegistryCredentialSchema,
  });
export const deleteRegistryCredential = (id: string) =>
  deleteIdempotent(`/registrycredentials/${encodeURIComponent(id)}`);

// ---- Environment Groups & Links ----
export const listEnvGroups = (query?: { ownerId?: string[]; environmentId?: string[] }) =>
  paginateCursor<typeof WireEnvGroupWithCursorSchema.Type, WireEnvGroupMeta>(
    "/env-groups",
    query,
    WireEnvGroupWithCursorSchema,
    (row) => row.envGroup,
  );
export const createEnvGroup = (body: WireEnvGroupCreateInput) =>
  request({ method: "POST", path: "/env-groups", body, schema: WireEnvGroupSchema });
export const getEnvGroup = (id: string) =>
  request({
    method: "GET",
    path: `/env-groups/${encodeURIComponent(id)}`,
    schema: WireEnvGroupSchema,
  });
export const updateEnvGroupName = (id: string, name: string) =>
  request({
    method: "PATCH",
    path: `/env-groups/${encodeURIComponent(id)}`,
    body: { name },
    schema: WireEnvGroupSchema,
  });
export const deleteEnvGroup = (id: string) =>
  deleteIdempotent(`/env-groups/${encodeURIComponent(id)}`);
export const putEnvGroupEnvVar = (
  envGroupId: string,
  key: string,
  body: { readonly value: string } | { readonly generateValue: boolean },
) =>
  request({
    method: "PUT",
    path: `/env-groups/${encodeURIComponent(envGroupId)}/env-vars/${encodeURIComponent(key)}`,
    body,
    schema: WireEnvGroupSchema,
  });
export const deleteEnvGroupEnvVar = (envGroupId: string, key: string) =>
  deleteIdempotent(
    `/env-groups/${encodeURIComponent(envGroupId)}/env-vars/${encodeURIComponent(key)}`,
  );
export const putEnvGroupSecretFile = (envGroupId: string, name: string, content: string) =>
  request({
    method: "PUT",
    path: `/env-groups/${encodeURIComponent(envGroupId)}/secret-files/${encodeURIComponent(name)}`,
    body: { content },
    schema: WireEnvGroupSchema,
  });
export const deleteEnvGroupSecretFile = (envGroupId: string, name: string) =>
  deleteIdempotent(
    `/env-groups/${encodeURIComponent(envGroupId)}/secret-files/${encodeURIComponent(name)}`,
  );
export const linkServiceToEnvGroup = (envGroupId: string, serviceId: string) =>
  request({
    method: "POST",
    path: `/env-groups/${encodeURIComponent(envGroupId)}/services/${encodeURIComponent(serviceId)}`,
    schema: WireEnvGroupSchema,
  });
export const unlinkServiceFromEnvGroup = (envGroupId: string, serviceId: string) =>
  deleteIdempotent(
    `/env-groups/${encodeURIComponent(envGroupId)}/services/${encodeURIComponent(serviceId)}`,
  );

// ---- Services ----
export const listServices = (query?: { ownerId?: string[]; name?: string[]; type?: string[] }) =>
  paginateCursor<typeof WireServiceWithCursorSchema.Type, WireService>(
    "/services",
    query,
    WireServiceWithCursorSchema,
    (r) => r.service,
  );
export const createService = (body: Record<string, unknown>) =>
  request({ method: "POST", path: "/services", body, schema: WireServiceAndDeploySchema });
export const getService = (id: string) =>
  request({
    method: "GET",
    path: `/services/${encodeURIComponent(id)}`,
    schema: WireServiceSchema,
  });
export const updateService = (id: string, body: Record<string, unknown>) =>
  request({
    method: "PATCH",
    path: `/services/${encodeURIComponent(id)}`,
    body,
    schema: WireServiceSchema,
  });
export const deleteService = (id: string) =>
  deleteIdempotent(`/services/${encodeURIComponent(id)}`);
export const suspendService = (id: string) =>
  requestVoid({ method: "POST", path: `/services/${encodeURIComponent(id)}/suspend` });
export const resumeService = (id: string) =>
  requestVoid({ method: "POST", path: `/services/${encodeURIComponent(id)}/resume` });
export const purgeServiceCache = (id: string) =>
  requestVoid({ method: "POST", path: `/services/${encodeURIComponent(id)}/cache/purge` });
export const createServicePreview = (
  serviceId: string,
  body: { imagePath: string; name?: string; plan?: string },
) =>
  request({
    method: "POST",
    path: `/services/${encodeURIComponent(serviceId)}/preview`,
    body,
    schema: WireServiceAndDeploySchema,
  });

export const listServiceEnvVars = (serviceId: string) =>
  paginateCursor<typeof WireEnvVarWithCursorSchema.Type, WireEnvVar>(
    `/services/${encodeURIComponent(serviceId)}/env-vars`,
    undefined,
    WireEnvVarWithCursorSchema,
    (r) => r.envVar,
  );
export const putServiceEnvVars = (serviceId: string, body: WireEnvVarInput[]) =>
  request({
    method: "PUT",
    path: `/services/${encodeURIComponent(serviceId)}/env-vars`,
    body,
    schema: WireEnvVarWithCursorListSchema,
  }).pipe(Effect.map((rows) => rows.map((r) => r.envVar)));

export const listServiceSecretFiles = (serviceId: string) =>
  paginateCursor<typeof WireSecretFileWithCursorSchema.Type, WireSecretFile>(
    `/services/${encodeURIComponent(serviceId)}/secret-files`,
    undefined,
    WireSecretFileWithCursorSchema,
    (r) => r.secretFile,
  );
export const putServiceSecretFiles = (serviceId: string, body: WireSecretFile[]) =>
  request({
    method: "PUT",
    path: `/services/${encodeURIComponent(serviceId)}/secret-files`,
    body,
    schema: WireSecretFileWithCursorListSchema,
  }).pipe(Effect.map((rows) => rows.map((r) => r.secretFile)));

export const listCustomDomains = (serviceId: string) =>
  paginateCursor<typeof WireCustomDomainWithCursorSchema.Type, WireCustomDomain>(
    `/services/${encodeURIComponent(serviceId)}/custom-domains`,
    undefined,
    WireCustomDomainWithCursorSchema,
    (r) => r.customDomain,
  );
export const createCustomDomain = (serviceId: string, name: string) =>
  request({
    method: "POST",
    path: `/services/${encodeURIComponent(serviceId)}/custom-domains`,
    body: { name },
    schema: WireCustomDomainListSchema,
  });
export const verifyCustomDomain = (serviceId: string, domainIdOrName: string) =>
  requestVoid({
    method: "POST",
    path: `/services/${encodeURIComponent(serviceId)}/custom-domains/${encodeURIComponent(domainIdOrName)}/verify`,
  });
export const deleteCustomDomain = (serviceId: string, domainIdOrName: string) =>
  deleteIdempotent(
    `/services/${encodeURIComponent(serviceId)}/custom-domains/${encodeURIComponent(domainIdOrName)}`,
  );

export const listDisks = (query?: { ownerId?: string[] }) =>
  paginateCursor<typeof WireDiskWithCursorSchema.Type, WireDiskDetails>(
    "/disks",
    query,
    WireDiskWithCursorSchema,
    (r) => r.disk,
  );
export const addDisk = (body: {
  name: string;
  mountPath: string;
  sizeGB: number;
  serviceId: string;
}) => request({ method: "POST", path: "/disks", body, schema: WireDiskDetailsSchema });
export const updateDisk = (
  diskId: string,
  body: { name?: string; mountPath?: string; sizeGB?: number },
) =>
  request({
    method: "PATCH",
    path: `/disks/${encodeURIComponent(diskId)}`,
    body,
    schema: WireDiskDetailsSchema,
  });
export const deleteDisk = (diskId: string) =>
  deleteIdempotent(`/disks/${encodeURIComponent(diskId)}`);

export const scaleService = (serviceId: string, numInstances: number) =>
  requestVoid({
    method: "POST",
    path: `/services/${encodeURIComponent(serviceId)}/scale`,
    body: { numInstances },
  });
export const putAutoscaling = (serviceId: string, body: Record<string, unknown>) =>
  requestVoid({
    method: "PUT",
    path: `/services/${encodeURIComponent(serviceId)}/autoscaling`,
    body,
  });
export const deleteAutoscaling = (serviceId: string) =>
  deleteIdempotent(`/services/${encodeURIComponent(serviceId)}/autoscaling`);

export const listHeaders = (serviceId: string) =>
  paginateCursor<typeof WireHeaderWithCursorSchema.Type, WireHeader>(
    `/services/${encodeURIComponent(serviceId)}/headers`,
    undefined,
    WireHeaderWithCursorSchema,
    (r) => r.header,
  );
export const putHeaders = (
  serviceId: string,
  headers: Array<{ path: string; name: string; value: string }>,
) =>
  request({
    method: "PUT",
    path: `/services/${encodeURIComponent(serviceId)}/headers`,
    body: headers,
    schema: WireHeaderListSchema,
  });

export const listRoutes = (serviceId: string) =>
  paginateCursor<typeof WireRouteWithCursorSchema.Type, WireRoute>(
    `/services/${encodeURIComponent(serviceId)}/routes`,
    undefined,
    WireRouteWithCursorSchema,
    (r) => r.route,
  );
export const putRoutes = (
  serviceId: string,
  routes: Array<{ source: string; destination: string; type: string }>,
) =>
  request({
    method: "PUT",
    path: `/services/${encodeURIComponent(serviceId)}/routes`,
    body: routes,
    schema: WireRouteListSchema,
  });

export const listDeploys = (serviceId: string) =>
  paginateCursor<typeof WireDeployWithCursorSchema.Type, WireDeploy>(
    `/services/${encodeURIComponent(serviceId)}/deploys`,
    undefined,
    WireDeployWithCursorSchema,
    (r) => r.deploy,
  );
export const createDeploy = (serviceId: string) =>
  request({
    method: "POST",
    path: `/services/${encodeURIComponent(serviceId)}/deploys`,
    body: {},
    schema: WireDeployCreateResponseSchema,
  });

export const getServiceNotificationOverride = (serviceId: string) =>
  request({
    method: "GET",
    path: `/notification-settings/overrides/services/${encodeURIComponent(serviceId)}`,
    schema: WireNotificationOverrideSchema,
  });
export const patchServiceNotificationOverride = (
  serviceId: string,
  body: { notificationsToSend?: string; previewNotificationsEnabled?: string },
) =>
  request({
    method: "PATCH",
    path: `/notification-settings/overrides/services/${encodeURIComponent(serviceId)}`,
    body,
    schema: WireNotificationOverrideSchema,
  });

export const getResourceLogStream = (resourceId: string) =>
  request({
    method: "GET",
    path: `/logs/streams/resource/${encodeURIComponent(resourceId)}`,
    schema: WireResourceLogStreamSettingSchema,
  });
export const putResourceLogStream = (
  resourceId: string,
  body: { setting: string; endpoint?: string; token?: string },
) =>
  request({
    method: "PUT",
    path: `/logs/streams/resource/${encodeURIComponent(resourceId)}`,
    body,
    schema: WireResourceLogStreamSettingSchema,
  });
export const deleteResourceLogStream = (resourceId: string) =>
  deleteIdempotent(`/logs/streams/resource/${encodeURIComponent(resourceId)}`);

// ---- Postgres ----
export const listPostgres = (query?: { ownerId?: string[]; name?: string[] }) =>
  paginateCursor<typeof WirePostgresWithCursorSchema.Type, WirePostgres>(
    "/postgres",
    query,
    WirePostgresWithCursorSchema,
    (r) => r.postgres,
  );
export const createPostgres = (body: Record<string, unknown>) =>
  request({ method: "POST", path: "/postgres", body, schema: WirePostgresSchema });
export const getPostgres = (id: string) =>
  request({
    method: "GET",
    path: `/postgres/${encodeURIComponent(id)}`,
    schema: WirePostgresSchema,
  });
export const updatePostgres = (id: string, body: Record<string, unknown>) =>
  request({
    method: "PATCH",
    path: `/postgres/${encodeURIComponent(id)}`,
    body,
    schema: WirePostgresSchema,
  });
export const deletePostgres = (id: string) =>
  deleteIdempotent(`/postgres/${encodeURIComponent(id)}`);
export const getPostgresConnectionInfo = (id: string) =>
  request({
    method: "GET",
    path: `/postgres/${encodeURIComponent(id)}/connection-info`,
    schema: WirePostgresConnectionInfoSchema,
  });
export const suspendPostgres = (id: string) =>
  requestVoid({ method: "POST", path: `/postgres/${encodeURIComponent(id)}/suspend` });
export const resumePostgres = (id: string) =>
  requestVoid({ method: "POST", path: `/postgres/${encodeURIComponent(id)}/resume` });
export const getPostgresRecovery = (id: string) =>
  request({
    method: "GET",
    path: `/postgres/${encodeURIComponent(id)}/recovery`,
    schema: WirePostgresRecoveryInfoSchema,
  });
export const triggerPostgresRecovery = (
  sourcePostgresId: string,
  body: { restoreName: string; restoreTime: string; plan?: string },
) =>
  request({
    method: "POST",
    path: `/postgres/${encodeURIComponent(sourcePostgresId)}/recovery`,
    body,
    schema: WirePostgresSchema,
  });
export const listPostgresExports = (id: string) =>
  request({
    method: "GET",
    path: `/postgres/${encodeURIComponent(id)}/export`,
    schema: WirePostgresExportListSchema,
  });
export const createPostgresExport = (id: string) =>
  request({
    method: "POST",
    path: `/postgres/${encodeURIComponent(id)}/export`,
    body: {},
    schema: WirePostgresExportSchema,
  });

// ---- KeyValue ----
export const listKeyValue = (query?: { ownerId?: string[]; name?: string[] }) =>
  paginateCursor<typeof WireKeyValueWithCursorSchema.Type, WireKeyValue>(
    "/key-value",
    query,
    WireKeyValueWithCursorSchema,
    (r) => r.keyValue,
  );
export const createKeyValue = (body: Record<string, unknown>) =>
  request({ method: "POST", path: "/key-value", body, schema: WireKeyValueSchema });
export const getKeyValue = (id: string) =>
  request({
    method: "GET",
    path: `/key-value/${encodeURIComponent(id)}`,
    schema: WireKeyValueSchema,
  });
export const updateKeyValue = (id: string, body: Record<string, unknown>) =>
  request({
    method: "PATCH",
    path: `/key-value/${encodeURIComponent(id)}`,
    body,
    schema: WireKeyValueSchema,
  });
export const deleteKeyValue = (id: string) =>
  deleteIdempotent(`/key-value/${encodeURIComponent(id)}`);
export const getKeyValueConnectionInfo = (id: string) =>
  request({
    method: "GET",
    path: `/key-value/${encodeURIComponent(id)}/connection-info`,
    schema: WireKeyValueConnectionInfoSchema,
  });

// ---- Redis ----
export const listRedis = (query?: { ownerId?: string[]; name?: string[] }) =>
  paginateCursor<typeof WireRedisWithCursorSchema.Type, WireRedis>(
    "/redis",
    query,
    WireRedisWithCursorSchema,
    (r) => r.redis,
  );
export const createRedis = (body: Record<string, unknown>) =>
  request({ method: "POST", path: "/redis", body, schema: WireRedisSchema });
export const getRedis = (id: string) =>
  request({
    method: "GET",
    path: `/redis/${encodeURIComponent(id)}`,
    schema: WireRedisSchema,
  });
export const updateRedis = (id: string, body: Record<string, unknown>) =>
  request({
    method: "PATCH",
    path: `/redis/${encodeURIComponent(id)}`,
    body,
    schema: WireRedisSchema,
  });
export const deleteRedis = (id: string) => deleteIdempotent(`/redis/${encodeURIComponent(id)}`);
export const getRedisConnectionInfo = (id: string) =>
  request({
    method: "GET",
    path: `/redis/${encodeURIComponent(id)}/connection-info`,
    schema: WireRedisConnectionInfoSchema,
  });

// ---- Webhooks ----
export const listWebhooks = (query?: { ownerId?: string[] }) =>
  paginateCursor<typeof WireWebhookWithCursorSchema.Type, WireWebhook>(
    "/webhooks",
    query,
    WireWebhookWithCursorSchema,
    (r) => r.webhook,
  );
export const createWebhook = (body: Record<string, unknown>) =>
  request({ method: "POST", path: "/webhooks", body, schema: WireWebhookSchema });
export const getWebhook = (id: string) =>
  request({
    method: "GET",
    path: `/webhooks/${encodeURIComponent(id)}`,
    schema: WireWebhookSchema,
  });
export const updateWebhook = (id: string, body: Record<string, unknown>) =>
  request({
    method: "PATCH",
    path: `/webhooks/${encodeURIComponent(id)}`,
    body,
    schema: WireWebhookSchema,
  });
export const deleteWebhook = (id: string) =>
  deleteIdempotent(`/webhooks/${encodeURIComponent(id)}`);

// ---- Dedicated IPs ----
export const listDedicatedIps = (query?: { ownerId?: string[]; region?: string[] }) =>
  request({
    method: "GET",
    path: "/dedicated-ips",
    query,
    schema: WireDedicatedIpListSchema,
  });
export const createDedicatedIp = (body: Record<string, unknown>) =>
  request({ method: "POST", path: "/dedicated-ips", body, schema: WireDedicatedIpSchema });
export const getDedicatedIp = (id: string) =>
  request({
    method: "GET",
    path: `/dedicated-ips/${encodeURIComponent(id)}`,
    schema: WireDedicatedIpSchema,
  });
export const updateDedicatedIp = (id: string, body: Record<string, unknown>) =>
  request({
    method: "PATCH",
    path: `/dedicated-ips/${encodeURIComponent(id)}`,
    body,
    schema: WireDedicatedIpSchema,
  });
export const deleteDedicatedIp = (id: string) =>
  deleteIdempotent(`/dedicated-ips/${encodeURIComponent(id)}`);

// ---- Workflows & Task Runs ----
export const listWorkflows = (query?: {
  ownerId?: string[];
  name?: string[];
  environmentId?: string[];
}) =>
  paginateCursor<typeof WireWorkflowWithCursorSchema.Type, WireWorkflow>(
    "/workflows",
    query,
    WireWorkflowWithCursorSchema,
    (r) => r.workflow,
  );
export const createWorkflow = (body: Record<string, unknown>) =>
  request({ method: "POST", path: "/workflows", body, schema: WireWorkflowSchema });
export const getWorkflow = (id: string) =>
  request({
    method: "GET",
    path: `/workflows/${encodeURIComponent(id)}`,
    schema: WireWorkflowSchema,
  });
export const updateWorkflow = (id: string, body: Record<string, unknown>) =>
  request({
    method: "PATCH",
    path: `/workflows/${encodeURIComponent(id)}`,
    body,
    schema: WireWorkflowSchema,
  });
export const deleteWorkflow = (id: string) =>
  deleteIdempotent(`/workflows/${encodeURIComponent(id)}`);

export const listWorkflowVersions = (workflowId: string) =>
  paginateCursor<typeof WireWorkflowVersionWithCursorSchema.Type, WireWorkflowVersion>(
    `/workflows/${encodeURIComponent(workflowId)}/versions`,
    undefined,
    WireWorkflowVersionWithCursorSchema,
    (r) => r.workflowVersion,
  );
export const createWorkflowVersion = (workflowId: string, body: Record<string, unknown> = {}) =>
  request({
    method: "POST",
    path: `/workflows/${encodeURIComponent(workflowId)}/versions`,
    body,
    schema: WireWorkflowVersionSchema,
  });
export const getWorkflowVersion = (versionId: string) =>
  request({
    method: "GET",
    path: `/workflowversions/${encodeURIComponent(versionId)}`,
    schema: WireWorkflowVersionSchema,
  });

export const createTaskRun = (body: { task: string; input?: unknown }) =>
  request({ method: "POST", path: "/task-runs", body, schema: WireTaskRunSchema });
export const getTaskRun = (taskRunId: string) =>
  request({
    method: "GET",
    path: `/task-runs/${encodeURIComponent(taskRunId)}`,
    schema: WireTaskRunSchema,
  });
export const listTaskRuns = (query?: { ownerId?: string[]; task?: string[]; status?: string[] }) =>
  paginateCursor<typeof WireTaskRunWithCursorSchema.Type, WireTaskRun>(
    "/task-runs",
    query,
    WireTaskRunWithCursorSchema,
    (r) => r.taskRun,
  );
export const cancelTaskRun = (taskRunId: string) =>
  deleteIdempotent(`/task-runs/${encodeURIComponent(taskRunId)}`);

// ---- Blueprints ----
export const listBlueprints = (query?: { ownerId?: string[] }) =>
  paginateCursor<typeof WireBlueprintWithCursorSchema.Type, WireBlueprint>(
    "/blueprints",
    query,
    WireBlueprintWithCursorSchema,
    (r) => r.blueprint,
  );
export const getBlueprint = (id: string) =>
  request({
    method: "GET",
    path: `/blueprints/${encodeURIComponent(id)}`,
    schema: WireBlueprintDetailSchema,
  });
export const updateBlueprint = (
  id: string,
  body: { name?: string; autoSync?: boolean; branch?: string; path?: string },
) =>
  request({
    method: "PATCH",
    path: `/blueprints/${encodeURIComponent(id)}`,
    body,
    schema: WireBlueprintSchema,
  });
export const deleteBlueprint = (id: string) =>
  deleteIdempotent(`/blueprints/${encodeURIComponent(id)}`);
export const listBlueprintSyncs = (id: string) =>
  paginateCursor<typeof WireBlueprintSyncWithCursorSchema.Type, WireBlueprintSync>(
    `/blueprints/${encodeURIComponent(id)}/syncs`,
    undefined,
    WireBlueprintSyncWithCursorSchema,
    (r) => r.sync,
  );
export const validateBlueprint = (
  ownerId: string,
  yamlContent: string,
  filename = "render.yaml",
) => {
  const formData = new FormData();
  formData.set("ownerId", ownerId);
  formData.set("file", new Blob([yamlContent], { type: "application/yaml" }), filename);
  return requestMultipart({
    path: "/blueprints/validate",
    formData,
    schema: WireBlueprintValidateResponseSchema,
  });
};

// ---- Logs ----
export const listLogs = (query: {
  ownerId: string;
  resource?: string[];
  project?: string;
  environment?: string;
  region?: string;
  startTime?: string;
  endTime?: string;
  direction?: "forward" | "backward";
  limit?: number;
}) =>
  request({
    method: "GET",
    path: "/logs",
    query,
    schema: WireLogsResponseSchema,
  });

// ---- Owner Singletons: LogStream, MetricsStream, NotificationSetting ----
export const getOwnerLogStream = (ownerId: string) =>
  request({
    method: "GET",
    path: `/logs/streams/owner/${encodeURIComponent(ownerId)}`,
    schema: WireOwnerLogStreamSettingSchema,
  });
export const putOwnerLogStream = (
  ownerId: string,
  body: { preview: string; endpoint?: string; token?: string },
) =>
  request({
    method: "PUT",
    path: `/logs/streams/owner/${encodeURIComponent(ownerId)}`,
    body,
    schema: WireOwnerLogStreamSettingSchema,
  });
export const deleteOwnerLogStream = (ownerId: string) =>
  deleteIdempotent(`/logs/streams/owner/${encodeURIComponent(ownerId)}`);

export const getOwnerMetricsStream = (ownerId: string) =>
  request({
    method: "GET",
    path: `/metrics-stream/${encodeURIComponent(ownerId)}`,
    schema: WireMetricsStreamSchema,
  });
export const putOwnerMetricsStream = (
  ownerId: string,
  body: { provider?: string; url?: string; token?: string },
) =>
  request({
    method: "PUT",
    path: `/metrics-stream/${encodeURIComponent(ownerId)}`,
    body,
    schema: WireMetricsStreamSchema,
  });
export const deleteOwnerMetricsStream = (ownerId: string) =>
  deleteIdempotent(`/metrics-stream/${encodeURIComponent(ownerId)}`);

export const getOwnerNotificationSettings = (ownerId: string) =>
  request({
    method: "GET",
    path: `/notification-settings/owners/${encodeURIComponent(ownerId)}`,
    schema: WireNotificationSettingSchema,
  });
export const patchOwnerNotificationSettings = (
  ownerId: string,
  body: {
    emailEnabled?: boolean;
    notificationsToSend?: string;
    previewNotificationsEnabled?: boolean;
  },
) =>
  request({
    method: "PATCH",
    path: `/notification-settings/owners/${encodeURIComponent(ownerId)}`,
    body,
    schema: WireNotificationSettingSchema,
  });
