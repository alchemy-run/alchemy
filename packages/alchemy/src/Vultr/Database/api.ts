import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import type { HttpMethod } from "effect/unstable/http/HttpMethod";
import { Credentials } from "../Credentials.ts";

/**
 * Direct HTTP client wrappers for the Vultr Managed Databases API.
 *
 * The Vultr `/v2/databases` surface is one parent resource (the cluster)
 * with four sub-resource collections living under
 * `/v2/databases/{id}/{users,dbs,connection-pools,read-replicas}`. We
 * keep all of them co-located here so the shared `request` helper and
 * tagged errors live in one place.
 */

export class VultrDbApiError extends Data.TaggedError("VultrDbApiError")<{
  status: number;
  method: string;
  url: string;
  message: string;
  body?: unknown;
}> {}

export class DatabaseNotFound extends Data.TaggedError("DatabaseNotFound")<{
  databaseId: string;
}> {}

export class DatabaseUserNotFound extends Data.TaggedError(
  "DatabaseUserNotFound",
)<{
  databaseId: string;
  username: string;
}> {}

export class LogicalDbNotFound extends Data.TaggedError("LogicalDbNotFound")<{
  databaseId: string;
  name: string;
}> {}

export class ConnectionPoolNotFound extends Data.TaggedError(
  "ConnectionPoolNotFound",
)<{
  databaseId: string;
  name: string;
}> {}

export class ReadReplicaNotFound extends Data.TaggedError(
  "ReadReplicaNotFound",
)<{
  databaseId: string;
}> {}

/**
 * Status flow: Configuring → Rebuilding → Rebalancing → Running.
 *
 * Vultr's API returns these strings with an upper-case first letter
 * (e.g. `"Running"`), unlike most of the rest of the response which is
 * lower-case. `waitForRunning` normalises before comparing so callers
 * can rely on either casing — but the canonical string we store as
 * output is the one the API returned (Capitalised).
 */
export type DatabaseStatus =
  | "Configuring"
  | "Rebuilding"
  | "Rebalancing"
  | "Running"
  | "Poweroff"
  | (string & {});

export interface VultrDatabaseInfo {
  id: string;
  date_created: string;
  plan: string;
  plan_disk: number;
  plan_ram: number;
  plan_vcpus: number;
  plan_replicas: number;
  region: string;
  database_engine: "pg" | "mysql" | "valkey" | "kafka";
  database_engine_version: string;
  vpc_id: string;
  status: DatabaseStatus;
  label: string;
  tag: string;
  dbname: string;
  ferretdb_credentials?: Record<string, string>;
  host: string;
  public_host?: string;
  port: string;
  sasl_port?: string;
  user: string;
  password: string;
  maintenance_dow: string;
  maintenance_time: string;
  backup_hour: string;
  backup_minute: string;
  latest_backup: string;
  trusted_ips: string[];
  cluster_time_zone: string;
  read_replicas?: VultrDatabaseInfo[];
}

export interface CreateDatabaseInput {
  database_engine: "pg";
  database_engine_version: string;
  region: string;
  plan: string;
  label: string;
  tag?: string;
  vpc_id?: string;
  trusted_ips?: string[];
  maintenance_dow?: string;
  maintenance_time?: string;
  backup_hour?: string;
  backup_minute?: string;
  cluster_time_zone?: string;
  password?: string;
  plan_disk?: number;
  plan_replicas?: number;
  ferretdb_credentials?: Record<string, string>;
}

export interface UpdateDatabaseInput {
  label?: string;
  tag?: string;
  plan?: string;
  trusted_ips?: string[];
  maintenance_dow?: string;
  maintenance_time?: string;
  backup_hour?: string;
  backup_minute?: string;
  cluster_time_zone?: string;
  password?: string;
  plan_disk?: number;
  plan_replicas?: number;
}

export interface VultrDatabaseUserInfo {
  username: string;
  password: string;
  encryption?: string;
  permission?: "admin" | "read" | "write" | "readwrite";
  access_control?: Record<string, unknown>;
  access_cert?: string;
  access_key?: string;
}

export interface VultrLogicalDbInfo {
  name: string;
}

export interface VultrConnectionPoolInfo {
  name: string;
  database: string;
  username: string;
  mode: "session" | "transaction" | "statement";
  size: number;
}

const request = <A>(
  method: HttpMethod,
  path: string,
  body?: unknown,
): Effect.Effect<A, VultrDbApiError, Credentials | HttpClient.HttpClient> =>
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
            new VultrDbApiError({
              status: 0,
              method,
              url,
              message: `serialize: ${String(e)}`,
            }),
        ),
      );
    }
    const response = yield* client.execute(req).pipe(
      Effect.scoped,
      Effect.mapError(
        (e) =>
          new VultrDbApiError({
            status: 0,
            method,
            url,
            message: `network: ${String(e)}`,
          }),
      ),
    );
    if (response.status === 204) return undefined as A;
    const text = yield* response.text.pipe(
      Effect.mapError(
        (e) =>
          new VultrDbApiError({
            status: response.status,
            method,
            url,
            message: `read body: ${String(e)}`,
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
      const msg =
        (typeof parsed === "object" &&
          parsed != null &&
          (parsed as { error?: string }).error) ||
        `HTTP ${response.status}`;
      return yield* new VultrDbApiError({
        status: response.status,
        method,
        url,
        message: msg,
        body: parsed,
      });
    }
    return parsed as A;
  });

// ─── Cluster ─────────────────────────────────────────────────────────

export const createDatabase = (input: CreateDatabaseInput) =>
  request<{ database: VultrDatabaseInfo }>("POST", "/databases", input);

export const getDatabase = (
  databaseId: string,
): Effect.Effect<
  { database: VultrDatabaseInfo },
  VultrDbApiError | DatabaseNotFound,
  Credentials | HttpClient.HttpClient
> =>
  Effect.catchTag(
    request<{ database: VultrDatabaseInfo }>("GET", `/databases/${databaseId}`),
    "VultrDbApiError",
    (
      e,
    ): Effect.Effect<
      { database: VultrDatabaseInfo },
      VultrDbApiError | DatabaseNotFound
    > =>
      e.status === 404
        ? Effect.fail(new DatabaseNotFound({ databaseId }))
        : Effect.fail(e),
  );

export const updateDatabase = (
  databaseId: string,
  input: UpdateDatabaseInput,
) =>
  request<{ database: VultrDatabaseInfo }>(
    "PUT",
    `/databases/${databaseId}`,
    input,
  );

export const deleteDatabase = (databaseId: string) =>
  request<void>("DELETE", `/databases/${databaseId}`).pipe(
    Effect.catchTag("VultrDbApiError", (e) =>
      e.status === 404 ? Effect.succeed(undefined) : Effect.fail(e),
    ),
  );

export const listDatabases = (query?: {
  label?: string;
  tag?: string;
  region?: string;
}) =>
  request<{
    databases: VultrDatabaseInfo[];
    meta: { total: number; links: { next: string; prev: string } };
  }>(
    "GET",
    "/databases" +
      (query
        ? "?" +
          Object.entries(query)
            .filter(([, v]) => v !== undefined)
            .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
            .join("&")
        : ""),
  );

/**
 * Poll `getDatabase` until `status === "running"`. Vultr typically
 * promotes a fresh hobbyist pg cluster within 3–5 minutes; HA tiers
 * (plan_replicas ≥ 1) take 8–15 minutes.
 */
export const waitForRunning = (databaseId: string) =>
  getDatabase(databaseId).pipe(
    Effect.flatMap(({ database }) =>
      database.status.toLowerCase() === "running"
        ? Effect.succeed(database)
        : Effect.fail(
            new VultrDbApiError({
              status: 0,
              method: "GET",
              url: `/databases/${databaseId}`,
              message: `database not yet running (status=${database.status})`,
            }),
          ),
    ),
    Effect.retry({
      while: (e: unknown) =>
        (e as { _tag?: string })._tag === "VultrDbApiError" ||
        (e as { _tag?: string })._tag === "DatabaseNotFound",
      schedule: Schedule.both(
        Schedule.exponential(Duration.seconds(5), 1.3),
        Schedule.recurs(120),
      ),
    }),
  );

// ─── Users ───────────────────────────────────────────────────────────

export interface CreateDatabaseUserInput {
  username: string;
  password?: string;
  encryption?: string;
  permission?: "admin" | "read" | "write" | "readwrite";
  access_control?: Record<string, unknown>;
}

export const createDatabaseUser = (
  databaseId: string,
  input: CreateDatabaseUserInput,
) =>
  request<{ user: VultrDatabaseUserInfo }>(
    "POST",
    `/databases/${databaseId}/users`,
    input,
  );

export const getDatabaseUser = (
  databaseId: string,
  username: string,
): Effect.Effect<
  { user: VultrDatabaseUserInfo },
  VultrDbApiError | DatabaseUserNotFound,
  Credentials | HttpClient.HttpClient
> =>
  Effect.catchTag(
    request<{ user: VultrDatabaseUserInfo }>(
      "GET",
      `/databases/${databaseId}/users/${encodeURIComponent(username)}`,
    ),
    "VultrDbApiError",
    (
      e,
    ): Effect.Effect<
      { user: VultrDatabaseUserInfo },
      VultrDbApiError | DatabaseUserNotFound
    > =>
      e.status === 404
        ? Effect.fail(new DatabaseUserNotFound({ databaseId, username }))
        : Effect.fail(e),
  );

export const updateDatabaseUser = (
  databaseId: string,
  username: string,
  input: { password?: string; access_control?: Record<string, unknown> },
) =>
  request<{ user: VultrDatabaseUserInfo }>(
    "PUT",
    `/databases/${databaseId}/users/${encodeURIComponent(username)}`,
    input,
  );

export const deleteDatabaseUser = (databaseId: string, username: string) =>
  request<void>(
    "DELETE",
    `/databases/${databaseId}/users/${encodeURIComponent(username)}`,
  ).pipe(
    Effect.catchTag("VultrDbApiError", (e) =>
      e.status === 404 ? Effect.succeed(undefined) : Effect.fail(e),
    ),
  );

export const listDatabaseUsers = (databaseId: string) =>
  request<{ users: VultrDatabaseUserInfo[] }>(
    "GET",
    `/databases/${databaseId}/users`,
  );

// ─── Logical DBs ─────────────────────────────────────────────────────

export const createLogicalDb = (databaseId: string, name: string) =>
  request<{ db: VultrLogicalDbInfo }>("POST", `/databases/${databaseId}/dbs`, {
    name,
  });

export const getLogicalDb = (
  databaseId: string,
  name: string,
): Effect.Effect<
  { db: VultrLogicalDbInfo },
  VultrDbApiError | LogicalDbNotFound,
  Credentials | HttpClient.HttpClient
> =>
  Effect.catchTag(
    request<{ db: VultrLogicalDbInfo }>(
      "GET",
      `/databases/${databaseId}/dbs/${encodeURIComponent(name)}`,
    ),
    "VultrDbApiError",
    (
      e,
    ): Effect.Effect<
      { db: VultrLogicalDbInfo },
      VultrDbApiError | LogicalDbNotFound
    > =>
      e.status === 404
        ? Effect.fail(new LogicalDbNotFound({ databaseId, name }))
        : Effect.fail(e),
  );

export const deleteLogicalDb = (databaseId: string, name: string) =>
  request<void>(
    "DELETE",
    `/databases/${databaseId}/dbs/${encodeURIComponent(name)}`,
  ).pipe(
    Effect.catchTag("VultrDbApiError", (e) =>
      e.status === 404 ? Effect.succeed(undefined) : Effect.fail(e),
    ),
  );

export const listLogicalDbs = (databaseId: string) =>
  request<{ dbs: VultrLogicalDbInfo[] }>("GET", `/databases/${databaseId}/dbs`);

// ─── Connection Pools ────────────────────────────────────────────────

export interface CreateConnectionPoolInput {
  name: string;
  database: string;
  username: string;
  mode: "session" | "transaction" | "statement";
  size: number;
}

export const createConnectionPool = (
  databaseId: string,
  input: CreateConnectionPoolInput,
) =>
  request<{ connection_pool: VultrConnectionPoolInfo }>(
    "POST",
    `/databases/${databaseId}/connection-pools`,
    input,
  );

export const getConnectionPool = (
  databaseId: string,
  name: string,
): Effect.Effect<
  { connection_pool: VultrConnectionPoolInfo },
  VultrDbApiError | ConnectionPoolNotFound,
  Credentials | HttpClient.HttpClient
> =>
  Effect.catchTag(
    request<{ connection_pool: VultrConnectionPoolInfo }>(
      "GET",
      `/databases/${databaseId}/connection-pools/${encodeURIComponent(name)}`,
    ),
    "VultrDbApiError",
    (
      e,
    ): Effect.Effect<
      { connection_pool: VultrConnectionPoolInfo },
      VultrDbApiError | ConnectionPoolNotFound
    > =>
      e.status === 404
        ? Effect.fail(new ConnectionPoolNotFound({ databaseId, name }))
        : Effect.fail(e),
  );

export const updateConnectionPool = (
  databaseId: string,
  name: string,
  input: { database?: string; username?: string; mode?: string; size?: number },
) =>
  request<{ connection_pool: VultrConnectionPoolInfo }>(
    "PUT",
    `/databases/${databaseId}/connection-pools/${encodeURIComponent(name)}`,
    input,
  );

export const deleteConnectionPool = (databaseId: string, name: string) =>
  request<void>(
    "DELETE",
    `/databases/${databaseId}/connection-pools/${encodeURIComponent(name)}`,
  ).pipe(
    Effect.catchTag("VultrDbApiError", (e) =>
      e.status === 404 ? Effect.succeed(undefined) : Effect.fail(e),
    ),
  );

export const listConnectionPools = (databaseId: string) =>
  request<{ connection_pools: VultrConnectionPoolInfo[] }>(
    "GET",
    `/databases/${databaseId}/connection-pools`,
  );

// ─── Read Replicas ───────────────────────────────────────────────────

export interface CreateReadReplicaInput {
  region: string;
  label: string;
  tag?: string;
  trusted_ips?: string[];
  plan_disk?: number;
  backup_hour?: string;
  backup_minute?: string;
}

export const createReadReplica = (
  databaseId: string,
  input: CreateReadReplicaInput,
) =>
  request<{ database: VultrDatabaseInfo }>(
    "POST",
    `/databases/${databaseId}/read-replica`,
    input,
  );

/**
 * Promote a read replica to a standalone primary. Detaches it from the
 * parent's lifecycle — alchemy treats this as out-of-band.
 */
export const promoteReadReplica = (databaseId: string) =>
  request<{ database: VultrDatabaseInfo }>(
    "POST",
    `/databases/${databaseId}/promote-read-replica`,
  );
