/**
 * Hand-rolled Effect client for the Archil Control Plane API.
 *
 * Every operation is an `Effect` requiring {@link Credentials} and
 * `HttpClient.HttpClient`, mirroring the distilled SDK shape so the same ops
 * serve both deploy-time lifecycle code (provided by `Archil.providers()`) and
 * the runtime binding clients (provided from a bound API token).
 *
 * All responses use the Archil envelope `{ success, data }` /
 * `{ success: false, error }`; errors are surfaced as typed tags per the
 * repo's Typed Error Doctrine.
 *
 * @see https://docs.archil.com/api-reference/introduction
 */
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { Credentials } from "./Credentials.ts";
import { endpointForRegion, type ArchilRegion } from "./Region.ts";

// ============================================================================
// Errors
// ============================================================================

/** Transport-level failure (network, TLS, malformed response). */
export class ArchilRequestError extends Data.TaggedError("ArchilRequestError")<{
  operation: string;
  message: string;
  cause?: unknown;
}> {}

/** Invalid or missing API key (HTTP 401). */
export class Unauthorized extends Data.TaggedError("Unauthorized")<{
  operation: string;
  message: string;
}> {}

/** Access denied — e.g. a preview region not enabled (HTTP 403). */
export class AccessDenied extends Data.TaggedError("AccessDenied")<{
  operation: string;
  message: string;
}> {}

/** Request validation failed (HTTP 400). */
export class ArchilValidationError extends Data.TaggedError(
  "ArchilValidationError",
)<{
  operation: string;
  message: string;
}> {}

/** Archil control-plane internal error (HTTP 5xx) — retryable. */
export class ArchilInternalError extends Data.TaggedError(
  "ArchilInternalError",
)<{
  operation: string;
  status: number;
  message: string;
}> {}

/** Catch-all for unexpected statuses — signals a gap in the typed union. */
export class ArchilApiError extends Data.TaggedError("ArchilApiError")<{
  operation: string;
  status: number;
  message: string;
}> {}

/** The referenced disk does not exist (HTTP 404 on a disk operation). */
export class DiskNotFound extends Data.TaggedError("DiskNotFound")<{
  diskId: string;
  message: string;
}> {}

/**
 * A disk with this name already exists with a different configuration
 * (HTTP 409 on create).
 */
export class DiskConflict extends Data.TaggedError("DiskConflict")<{
  name: string;
  message: string;
}> {}

/** The referenced API token does not exist (HTTP 404 on a token operation). */
export class ApiTokenNotFound extends Data.TaggedError("ApiTokenNotFound")<{
  tokenId: string;
  message: string;
}> {}

/**
 * A fork was requested with no explicit checkpoint and the disk has no
 * `committed` checkpoint to fork from. Checkpoints are taken from a mounted
 * disk (`archil checkpoints create <mountpoint> <name>`) — the control plane
 * exposes no route for creating them.
 */
export class NoCheckpoint extends Data.TaggedError("NoCheckpoint")<{
  diskId: string;
  branch?: string;
}> {}

/** The exec command hit the server-side timeout (HTTP 504). */
export class ExecTimeout extends Data.TaggedError("ExecTimeout")<{
  message: string;
}> {}

/**
 * Serverless execution is not available in the disk's region (storage-only
 * regions such as `gcp-us-central1`).
 */
export class ExecNotEnabled extends Data.TaggedError("ExecNotEnabled")<{
  region: ArchilRegion;
  message: string;
}> {}

export type CommonError =
  | ArchilRequestError
  | Unauthorized
  | AccessDenied
  | ArchilValidationError
  | ArchilInternalError
  | ArchilApiError;

/** True for errors worth a bounded retry (transient by construction). */
export const isTransientError = (e: { _tag: string }): boolean =>
  e._tag === "ArchilInternalError" || e._tag === "ArchilRequestError";

/**
 * Bounded retry for transient control-plane failures (5xx / transport).
 * Total backoff stays under ~10s per the repo speed doctrine.
 */
export const retryTransient = <A, E extends { _tag: string }, R>(
  eff: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(eff, {
    while: (e: E): boolean => isTransientError(e),
    schedule: Schedule.exponential("300 millis", 2),
    times: 4,
  });

// ============================================================================
// Wire types
// ============================================================================

export interface S3Mount {
  type: "s3";
  bucketName: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
  bucketPrefix?: string;
}

export interface GCSMount {
  type: "gcs";
  bucketName: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucketPrefix?: string;
}

export interface R2Mount {
  type: "r2";
  bucketName: string;
  bucketEndpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucketPrefix?: string;
}

export interface S3CompatibleMount {
  type: "s3-compatible";
  bucketName: string;
  bucketEndpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucketPrefix?: string;
}

export interface AzureBlobMount {
  type: "azure-blob";
  containerName: string;
  endpoint?: string;
  storageAccountName?: string;
  tenantId: string;
  clientId: string;
  clientSecret: string;
  bucketPrefix?: string;
}

/**
 * Storage backend synced with a disk. Omit for archil-managed storage.
 */
export type MountConfig =
  | S3Mount
  | GCSMount
  | R2Mount
  | S3CompatibleMount
  | AzureBlobMount;

export type DiskStatus =
  | "available"
  | "creating"
  | "deleting"
  | "deleted"
  | "failed";

export interface AuthorizedUser {
  type?: "token" | "awssts";
  principal?: string;
  nickname?: string;
  tokenSuffix?: string;
  /**
   * The generated disk token (used by clients when mounting). Present only
   * once, in the response that generated it.
   */
  token?: string;
  identifier?: string;
  createdAt?: string;
}

export interface DiskData {
  id: string;
  name: string;
  organization: string;
  status: DiskStatus;
  fsHandlerStatus?: string;
  provider: string;
  region: string;
  createdAt: string;
  lastAccessed?: string;
  dataSize?: number;
  monthlyUsage?: string;
  mounts?: Array<{
    id?: string;
    type?: MountConfig["type"];
    path?: string;
    name?: string;
    accessMode?: "rw" | "ro";
    connectionStatus?: "connected" | "disconnected";
    authError?: string;
    authorizationType?: "iam" | "accessKeys" | "oauth";
    config?: {
      bucketName?: string;
      bucketEndpoint?: string;
      bucketPrefix?: string;
      sessionId?: string;
    };
  }>;
  authorizedUsers?: AuthorizedUser[];
}

export type TokenDiskUser = {
  type: "token";
  nickname: string;
};

export type AwsStsDiskUser = {
  type: "awssts";
  /** IAM principal ARN allowed to mount via STS role assumption. */
  principal: string;
};

export type DiskUserSpec = TokenDiskUser | AwsStsDiskUser;

export interface ExecTiming {
  /** End-to-end wall clock measured on the server. */
  totalMs: number;
  /** Scheduling, boot, and mount overhead before the command started. */
  queueMs: number;
  /** Time the command itself ran — the billable portion. */
  executeMs: number;
}

export interface ExecResult {
  /** Exit code of the command (0 = success). */
  exitCode: number;
  stdout: string;
  stderr: string;
  timing: ExecTiming;
}

export interface ExecMountSpec {
  /** Disk ID to mount at this relative path. */
  disk: string;
  /** Subdirectory of the disk to expose (relative, no `.`/`..`). */
  subdirectory?: string;
  /** Mount read-only — writes fail with EROFS. @default false */
  readOnly?: boolean;
}

export interface GrepRequest {
  /** Directory to search, relative to the disk root (`""` or `/` = root). */
  directory: string;
  /** Extended regular expression (passed to `grep -E`). */
  pattern: string;
  /** Walk subdirectories breadth-first. @default false */
  recursive?: boolean;
  /** Wall-clock deadline for the whole request (1-30). @default 30 */
  maxDurationSeconds?: number;
  /** Maximum parallel grep workers (1-100). @default 50 */
  concurrency?: number;
  /** Stop after collecting this many matches (1-10000). @default 1000 */
  maxResults?: number;
}

export interface GrepMatch {
  /** Path to the file, relative to the disk root. */
  file: string;
  /** 1-based line number of the match. */
  line: number;
  /** The matching line. */
  text: string;
}

export type GrepStoppedReason =
  | "completed"
  | "incomplete"
  | "max_results"
  | "deadline"
  | "list_failed";

export interface GrepResult {
  matches: GrepMatch[];
  stoppedReason: GrepStoppedReason;
  filesScanned: number;
  containersDispatched: number;
  computeSecondsUsed: number;
  durationMs: number;
  listingMs: number;
  grepMs: number;
}

export interface ApiTokenData {
  id: string;
  name: string;
  description?: string;
  tokenSuffix?: string;
  createdAt?: string;
  lastUsedAt?: string;
}

// ============================================================================
// Request plumbing
// ============================================================================

interface Envelope {
  success?: boolean;
  data?: unknown;
  error?: string;
}

interface RequestOptions {
  method: "GET" | "POST" | "DELETE";
  region: ArchilRegion;
  path: string;
  body?: unknown;
  query?: Record<string, string | number | undefined>;
}

const request = <A, E = never>(
  operation: string,
  opts: RequestOptions,
  matchError?: (status: number, message: string) => E | undefined,
): Effect.Effect<A, E | CommonError, Credentials | HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const creds = yield* yield* Credentials;
    const client = yield* HttpClient.HttpClient;

    let req = HttpClientRequest.make(opts.method)(
      `${endpointForRegion(opts.region)}${opts.path}`,
    ).pipe(
      HttpClientRequest.setHeaders({
        Authorization: Redacted.value(creds.apiKey),
        Accept: "application/json",
      }),
    );
    if (opts.query) {
      const params: Record<string, string> = {};
      for (const [k, v] of Object.entries(opts.query)) {
        if (v !== undefined) params[k] = String(v);
      }
      req = HttpClientRequest.setUrlParams(req, params);
    }
    if (opts.body !== undefined) {
      req = HttpClientRequest.bodyJsonUnsafe(opts.body)(req);
    }

    const response = yield* client.execute(req).pipe(
      Effect.scoped,
      Effect.mapError(
        (cause) =>
          new ArchilRequestError({
            operation,
            message: `${opts.method} ${opts.path} failed: ${(cause as { message?: string }).message ?? String(cause)}`,
            cause,
          }),
      ),
    );

    const json = (yield* response.json.pipe(
      Effect.orElseSucceed(() => undefined),
    )) as Envelope | undefined;

    if (response.status >= 400 || json?.success === false) {
      const message = json?.error ?? `HTTP ${response.status}`;
      const matched = matchError?.(response.status, message);
      if (matched !== undefined) return yield* Effect.fail(matched as E);
      switch (true) {
        case response.status === 401:
          return yield* new Unauthorized({ operation, message });
        case response.status === 403:
          return yield* new AccessDenied({ operation, message });
        case response.status === 400:
          return yield* new ArchilValidationError({ operation, message });
        case response.status >= 500:
          return yield* new ArchilInternalError({
            operation,
            status: response.status,
            message,
          });
        default:
          return yield* new ArchilApiError({
            operation,
            status: response.status,
            message,
          });
      }
    }

    return json?.data as A;
  });

// ============================================================================
// Disks
// ============================================================================

export interface ListDisksInput {
  region: ArchilRegion;
  /** Filter by exact name match. */
  name?: string;
  limit?: number;
  cursor?: string;
}

export const listDisks = (
  input: ListDisksInput,
): Effect.Effect<
  DiskData[],
  CommonError,
  Credentials | HttpClient.HttpClient
> =>
  request<DiskData[] | undefined>("listDisks", {
    method: "GET",
    region: input.region,
    path: "/api/disks",
    query: { name: input.name, limit: input.limit, cursor: input.cursor },
  }).pipe(Effect.map((disks) => disks ?? []));

export interface CreateDiskInput {
  region: ArchilRegion;
  /** Disk name (alphanumeric, dashes, underscores; 1-100 chars). */
  name: string;
  /** Storage mount to sync with. Omit for archil-managed storage. */
  mounts?: MountConfig[];
}

export interface CreateDiskOutput {
  diskId: string;
  /**
   * The auto-generated default token user. The one-time disk token appears
   * in `authorizedUsers[].token` on a fresh create and cannot be retrieved
   * again.
   */
  authorizedUsers?: AuthorizedUser[];
}

export const createDisk = (
  input: CreateDiskInput,
): Effect.Effect<
  CreateDiskOutput,
  DiskConflict | CommonError,
  Credentials | HttpClient.HttpClient
> =>
  request<CreateDiskOutput, DiskConflict>(
    "createDisk",
    {
      method: "POST",
      region: input.region,
      path: "/api/disks",
      body: { name: input.name, mounts: input.mounts },
    },
    (status, message) =>
      status === 409
        ? new DiskConflict({ name: input.name, message })
        : undefined,
  );

export interface DiskIdInput {
  region: ArchilRegion;
  diskId: string;
}

export const getDisk = (
  input: DiskIdInput,
): Effect.Effect<
  DiskData,
  DiskNotFound | CommonError,
  Credentials | HttpClient.HttpClient
> =>
  request<DiskData, DiskNotFound>(
    "getDisk",
    {
      method: "GET",
      region: input.region,
      path: `/api/disks/${input.diskId}`,
    },
    (status, message) =>
      status === 404
        ? new DiskNotFound({ diskId: input.diskId, message })
        : undefined,
  );

export const deleteDisk = (
  input: DiskIdInput,
): Effect.Effect<
  void,
  DiskNotFound | CommonError,
  Credentials | HttpClient.HttpClient
> =>
  request<unknown, DiskNotFound>(
    "deleteDisk",
    {
      method: "DELETE",
      region: input.region,
      path: `/api/disks/${input.diskId}`,
    },
    (status, message) =>
      status === 404
        ? new DiskNotFound({ diskId: input.diskId, message })
        : undefined,
  ).pipe(Effect.asVoid);

// ============================================================================
// Disk Users
// ============================================================================

export interface AddDiskUserInput extends DiskIdInput {
  user: DiskUserSpec;
}

export const addDiskUser = (
  input: AddDiskUserInput,
): Effect.Effect<
  AuthorizedUser,
  DiskNotFound | CommonError,
  Credentials | HttpClient.HttpClient
> =>
  request<AuthorizedUser, DiskNotFound>(
    "addDiskUser",
    {
      method: "POST",
      region: input.region,
      path: `/api/disks/${input.diskId}/users`,
      body: input.user,
    },
    (status, message) =>
      status === 404
        ? new DiskNotFound({ diskId: input.diskId, message })
        : undefined,
  );

export interface RemoveDiskUserInput extends DiskIdInput {
  userType: "token" | "awssts";
  /** Identifier returned in the creation/list response (IAM ARN for awssts). */
  identifier?: string;
}

export const removeDiskUser = (
  input: RemoveDiskUserInput,
): Effect.Effect<
  void,
  DiskNotFound | CommonError,
  Credentials | HttpClient.HttpClient
> =>
  request<unknown, DiskNotFound>(
    "removeDiskUser",
    {
      method: "DELETE",
      region: input.region,
      path: `/api/disks/${input.diskId}/users/${input.userType}`,
      query: { identifier: input.identifier },
    },
    (status, message) =>
      status === 404
        ? new DiskNotFound({ diskId: input.diskId, message })
        : undefined,
  ).pipe(Effect.asVoid);

// ============================================================================
// Branches & Checkpoints
// ============================================================================

/**
 * A checkpoint: an immutable, point-in-time snapshot of a disk's filesystem.
 * The rough equivalent of a git commit.
 */
export interface CheckpointInfo {
  /** The disk (or branch) the checkpoint was taken on. */
  filesystemId: string;
  /** Checkpoint name — unique within the branch it was taken on. */
  checkpointName: string;
  /**
   * `pending` while the snapshot is still being committed; `committed`
   * once it is durable and safe to branch from.
   */
  status: CheckpointStatus;
  nonce?: string;
  createdAt?: string;
}

export type CheckpointStatus = "pending" | "committed";

/**
 * A branch: an independent, writable fork of a disk taken from a
 * checkpoint. Writes are isolated from the parent and from sibling
 * branches. The rough equivalent of a git branch.
 */
export interface BranchInfo {
  /** The disk this branch ultimately descends from. */
  rootFilesystemId: string;
  branchName: string;
  /** The branch's own filesystem id. */
  filesystemId: string;
  /** The checkpoint this branch was forked from. */
  fromCheckpointName: string;
  /** The filesystem the source checkpoint was taken on. */
  fromCheckpointFilesystemId?: string;
  createdAt?: string;
}

/**
 * Branch/checkpoint wire structs use snake_case, unlike the rest of the
 * Archil API. These decoders normalize to the camelCase shapes above.
 */
const decodeBranch = (raw: Record<string, unknown>): BranchInfo => ({
  rootFilesystemId: String(raw.root_filesystem_id ?? ""),
  branchName: String(raw.branch_name ?? ""),
  filesystemId: String(raw.filesystem_id ?? ""),
  fromCheckpointName: String(raw.from_checkpoint_name ?? ""),
  fromCheckpointFilesystemId:
    raw.from_checkpoint_filesystem_id === undefined ||
    raw.from_checkpoint_filesystem_id === null
      ? undefined
      : String(raw.from_checkpoint_filesystem_id),
  createdAt:
    raw.created_at === undefined || raw.created_at === null
      ? undefined
      : String(raw.created_at),
});

const decodeCheckpoint = (raw: Record<string, unknown>): CheckpointInfo => ({
  filesystemId: String(raw.filesystem_id ?? ""),
  checkpointName: String(raw.checkpoint_name ?? ""),
  status: (raw.status ?? "pending") as CheckpointStatus,
  nonce:
    raw.nonce === undefined || raw.nonce === null
      ? undefined
      : String(raw.nonce),
  createdAt:
    raw.created_at === undefined || raw.created_at === null
      ? undefined
      : String(raw.created_at),
});

/**
 * The response `data` for these routes is either the bare array/object or a
 * `{ branches }` / `{ checkpoints }` wrapper depending on the control-plane
 * build; accept both.
 */
const unwrapList = (data: unknown, key: string): Record<string, unknown>[] => {
  if (Array.isArray(data)) return data as Record<string, unknown>[];
  if (data && typeof data === "object") {
    const inner = (data as Record<string, unknown>)[key];
    if (Array.isArray(inner)) return inner as Record<string, unknown>[];
  }
  return [];
};

export const listBranches = (
  input: DiskIdInput,
): Effect.Effect<
  BranchInfo[],
  DiskNotFound | CommonError,
  Credentials | HttpClient.HttpClient
> =>
  request<unknown, DiskNotFound>(
    "listBranches",
    {
      method: "GET",
      region: input.region,
      path: `/api/disks/${input.diskId}/branches`,
    },
    (status, message) =>
      status === 404
        ? new DiskNotFound({ diskId: input.diskId, message })
        : undefined,
  ).pipe(Effect.map((data) => unwrapList(data, "branches").map(decodeBranch)));

export interface CreateBranchInput extends DiskIdInput {
  /** Name for the new branch — unique within the disk. */
  branchName: string;
  /** Checkpoint to fork from. Must be `committed`. */
  fromCheckpoint: string;
  /**
   * Branch the source checkpoint was taken on. Omit to fork from a
   * checkpoint on the disk's root branch.
   */
  fromBranch?: string;
}

export const createBranch = (
  input: CreateBranchInput,
): Effect.Effect<
  BranchInfo,
  DiskNotFound | CommonError,
  Credentials | HttpClient.HttpClient
> =>
  request<unknown, DiskNotFound>(
    "createBranch",
    {
      method: "POST",
      region: input.region,
      path: `/api/disks/${input.diskId}/branches`,
      body: {
        branch_name: input.branchName,
        from_checkpoint_name: input.fromCheckpoint,
        from_branch: input.fromBranch,
      },
    },
    (status, message) =>
      status === 404
        ? new DiskNotFound({ diskId: input.diskId, message })
        : undefined,
  ).pipe(
    Effect.map((data) => {
      const raw = (data ?? {}) as Record<string, unknown>;
      const inner = (raw.branch ?? raw) as Record<string, unknown>;
      return decodeBranch(inner);
    }),
  );

export interface ListCheckpointsInput extends DiskIdInput {
  /** List checkpoints on this branch instead of the disk's root branch. */
  branch?: string;
}

export const listCheckpoints = (
  input: ListCheckpointsInput,
): Effect.Effect<
  CheckpointInfo[],
  DiskNotFound | CommonError,
  Credentials | HttpClient.HttpClient
> =>
  request<unknown, DiskNotFound>(
    "listCheckpoints",
    {
      method: "GET",
      region: input.region,
      path: `/api/disks/${input.diskId}/checkpoints`,
      query: { branch: input.branch },
    },
    (status, message) =>
      status === 404
        ? new DiskNotFound({ diskId: input.diskId, message })
        : undefined,
  ).pipe(
    Effect.map((data) => unwrapList(data, "checkpoints").map(decodeCheckpoint)),
  );

// ============================================================================
// Serverless Execution
// ============================================================================

export type ExecError =
  | DiskNotFound
  | ExecTimeout
  | ExecNotEnabled
  | CommonError;

const matchExecError =
  (region: ArchilRegion, diskId: string) =>
  (
    status: number,
    message: string,
  ): DiskNotFound | ExecTimeout | ExecNotEnabled | undefined => {
    if (status === 404) return new DiskNotFound({ diskId, message });
    if (status === 504) return new ExecTimeout({ message });
    if (/not enabled/i.test(message)) {
      return new ExecNotEnabled({ region, message });
    }
    return undefined;
  };

export interface ExecDiskInput extends DiskIdInput {
  /** Shell command executed via `bash -c` with the disk at `/mnt/archil`. */
  command: string;
}

export const execDisk = (
  input: ExecDiskInput,
): Effect.Effect<ExecResult, ExecError, Credentials | HttpClient.HttpClient> =>
  request<ExecResult, DiskNotFound | ExecTimeout | ExecNotEnabled>(
    "execDisk",
    {
      method: "POST",
      region: input.region,
      path: `/api/disks/${input.diskId}/exec`,
      body: { command: input.command },
    },
    matchExecError(input.region, input.diskId),
  );

export interface ExecInput {
  region: ArchilRegion;
  /**
   * Map of relative path under `/mnt/archil` to the disk mounted there.
   * A plain disk ID mounts the disk's root read-write.
   */
  disks: Record<string, string | ExecMountSpec>;
  /** Shell command executed via `bash -c`. */
  command: string;
}

export const exec = (
  input: ExecInput,
): Effect.Effect<ExecResult, ExecError, Credentials | HttpClient.HttpClient> =>
  request<ExecResult, DiskNotFound | ExecTimeout | ExecNotEnabled>(
    "exec",
    {
      method: "POST",
      region: input.region,
      path: "/api/exec",
      body: { disks: input.disks, command: input.command },
    },
    matchExecError(input.region, "(multi)"),
  );

export type GrepError = DiskNotFound | ExecNotEnabled | CommonError;

export interface GrepDiskInput extends DiskIdInput, GrepRequest {}

export const grepDisk = (
  input: GrepDiskInput,
): Effect.Effect<
  GrepResult,
  GrepError,
  Credentials | HttpClient.HttpClient
> => {
  const { region, diskId, ...body } = input;
  return request<GrepResult, DiskNotFound | ExecNotEnabled>(
    "grepDisk",
    {
      method: "POST",
      region,
      path: `/api/disks/${diskId}/grep`,
      body,
    },
    (status, message) => {
      if (status === 404) return new DiskNotFound({ diskId, message });
      if (/not enabled/i.test(message)) {
        return new ExecNotEnabled({ region, message });
      }
      return undefined;
    },
  );
};

// ============================================================================
// API Tokens
// ============================================================================

export interface ListApiTokensInput {
  region: ArchilRegion;
  limit?: number;
  cursor?: string;
}

export const listApiTokens = (
  input: ListApiTokensInput,
): Effect.Effect<
  ApiTokenData[],
  CommonError,
  Credentials | HttpClient.HttpClient
> =>
  request<{ tokens?: ApiTokenData[] } | undefined>("listApiTokens", {
    method: "GET",
    region: input.region,
    path: "/api/tokens",
    query: { limit: input.limit, cursor: input.cursor },
  }).pipe(Effect.map((data) => data?.tokens ?? []));

export interface CreateApiTokenInput {
  region: ArchilRegion;
  /** Token name (1-100 chars). */
  name: string;
  /** Token description (max 500 chars). */
  description?: string;
}

export interface CreateApiTokenOutput extends ApiTokenData {
  /** Full token value — only returned once, at creation. */
  token: string;
}

export const createApiToken = (
  input: CreateApiTokenInput,
): Effect.Effect<
  CreateApiTokenOutput,
  CommonError,
  Credentials | HttpClient.HttpClient
> =>
  request<CreateApiTokenOutput>("createApiToken", {
    method: "POST",
    region: input.region,
    path: "/api/tokens",
    body: { name: input.name, description: input.description },
  });

export interface DeleteApiTokenInput {
  region: ArchilRegion;
  /** The token ID (hash). */
  tokenId: string;
}

export const deleteApiToken = (
  input: DeleteApiTokenInput,
): Effect.Effect<
  void,
  ApiTokenNotFound | CommonError,
  Credentials | HttpClient.HttpClient
> =>
  request<unknown, ApiTokenNotFound>(
    "deleteApiToken",
    {
      method: "DELETE",
      region: input.region,
      path: `/api/tokens/${input.tokenId}`,
    },
    (status, message) =>
      status === 404
        ? new ApiTokenNotFound({ tokenId: input.tokenId, message })
        : undefined,
  ).pipe(Effect.asVoid);
