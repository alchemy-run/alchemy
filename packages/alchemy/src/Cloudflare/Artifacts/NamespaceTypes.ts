import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

/*
 * Shared types and errors for the Cloudflare Artifacts Worker binding.
 *
 * These mirror the current Workers runtime surface documented at
 * https://developers.cloudflare.com/artifacts/api/workers-binding/ rather than
 * the (older) `@cloudflare/workers-types` declarations pinned in this repo,
 * which predate `repo.info()`, `log()`, `readCommit()`, `readTree()`,
 * `readBlob()` and `readFile()`.
 */

/** Token scope: `read` (clone/fetch/pull) or `write` (also push). */
export type TokenScope = "read" | "write";

/** Token state reported by `listTokens()`. */
export type TokenState = "active" | "expired" | "revoked";

/** Provisioning status of a listed repository. */
export type RepoStatus = "ready" | "importing" | "forking" | "creating";

/** Repository metadata returned by `repo.info()`. */
export interface RepoInfo {
  /** Unique repository ID. */
  id: string;
  /** Repository name. */
  name: string;
  /** Repository description, or null if not set. */
  description: string | null;
  /** Default branch name (e.g. `main`). */
  defaultBranch: string;
  /** ISO 8601 creation timestamp. */
  createdAt: string;
  /** ISO 8601 last-updated timestamp. */
  updatedAt: string;
  /** ISO 8601 timestamp of the last push, or null if never pushed. */
  lastPushAt: string | null;
  /** Fork/import source (e.g. `github:owner/repo`), or null. */
  source: string | null;
  /** Whether the repository is read-only. */
  readOnly: boolean;
  /** HTTPS git remote URL. */
  remote: string;
}

/** A repository entry in a `list()` page. */
export interface RepoListItem extends Omit<RepoInfo, "remote"> {
  /** HTTPS git remote URL (present on current runtimes). */
  remote?: string;
  /** Provisioning status. */
  status?: RepoStatus;
}

/** Result of `create()`, `import()` and `repo.fork()`. */
export interface CreateRepoResult {
  /** Unique repository ID. */
  id: string;
  /** Repository name. */
  name: string;
  /** Repository description, or null if not set. */
  description: string | null;
  /** Default branch name. */
  defaultBranch: string;
  /** HTTPS git remote URL. */
  remote: string;
  /**
   * Initial write token (`art_v…?expires=<unix_seconds>`). Secret — only
   * returned at creation time.
   */
  token: string;
  /** ISO 8601 token expiry (older runtimes only; parse `?expires=` otherwise). */
  tokenExpiresAt?: string;
}

/** A page of repositories from `list()`. */
export interface RepoListResult {
  /** Repositories in this page. */
  repos: RepoListItem[];
  /** Total number of repositories in the namespace. */
  total: number;
  /** Cursor for the next page, if there are more results. */
  cursor?: string;
}

/** Result of `repo.createToken()`. */
export interface CreateTokenResult {
  /** Unique token ID. */
  id: string;
  /** Plaintext token. Secret — only returned at creation time. */
  plaintext: string;
  /** Token scope. */
  scope: TokenScope;
  /** ISO 8601 expiry timestamp. */
  expiresAt: string;
}

/** Token metadata (no plaintext). */
export interface TokenInfo {
  /** Unique token ID. */
  id: string;
  /** Token scope. */
  scope: TokenScope;
  /** Token state. */
  state: TokenState;
  /** ISO 8601 creation timestamp. */
  createdAt: string;
  /** ISO 8601 expiry timestamp. */
  expiresAt: string;
}

/** Result of `repo.listTokens()`. */
export interface TokenListResult {
  /** Tokens for the repository. */
  tokens: TokenInfo[];
  /** Total number of tokens for the repository. */
  total: number;
}

/** Classification of a git tree entry derived from its mode. */
export type TreeEntryType = "tree" | "blob" | "symlink" | "gitlink" | "exec";

/** An immediate child of a git tree returned by `repo.readTree()`. */
export interface TreeEntry {
  /** Name relative to the tree being read. */
  name: string;
  /** Canonical git mode, such as `100644` or `40000`. */
  mode: string;
  /** Lowercase, 40-character SHA-1 object ID. */
  hash: string;
  /** Classification derived from `mode`. */
  type: TreeEntryType;
}

/** Decoded commit metadata returned by `repo.readCommit()` / `repo.log()`. */
export interface CommitMetadata {
  /** Lowercase, 40-character SHA-1 commit ID. */
  hash: string;
  /** SHA-1 ID of the commit's root tree. */
  treeHash: string;
  /** Commit message with one trailing newline removed. */
  message: string;
  /** Author identity. */
  author: { name: string; email: string };
  /** Committer identity. */
  committer: { name: string; email: string };
  /** Parent commit IDs in git order; empty for a root commit. */
  parents: string[];
  /** Author timestamp in Unix seconds. */
  authoredAt: number;
  /** Committer timestamp in Unix seconds. */
  committedAt: number;
}

/** Options for `create()`. */
export type CreateOptions = {
  /** Create the repository read-only. */
  readOnly?: boolean;
  /** Repository description. */
  description?: string;
  /** Default branch name. */
  setDefaultBranch?: string;
};

/** Parameters for `import()`. */
export type ImportOptions = {
  /** Public HTTPS git remote to import from. */
  source: { url: string; branch?: string; depth?: number };
  /** The repository to create. */
  target: {
    name: string;
    opts?: { description?: string; readOnly?: boolean };
  };
};

/** Options for `list()`. */
export type ListOptions = {
  /** Page size (1–200, default 50). */
  limit?: number;
  /** Cursor from the previous page. */
  cursor?: string;
};

/** Options for `repo.fork()`. */
export type ForkOptions = {
  description?: string;
  readOnly?: boolean;
  /** Copy only the default branch (default true). */
  defaultBranchOnly?: boolean;
};

/** Options for `repo.log()`. */
export type LogOptions = {
  /** Branch, tag, or commit hash (default `HEAD`). */
  ref?: string;
  /** Maximum commits (default 50, max 1000). */
  limit?: number;
  /** Number of commits to skip (default 0). */
  offset?: number;
};

/** Arguments for `repo.readFile()`. */
export type ReadFileOptions = {
  /** Branch, tag, or commit ID. */
  ref: string;
  /** Non-empty repository-relative path. */
  path: string;
};

/**
 * The native repository capability returned by `Artifacts.get()` on the
 * current Workers runtime (an RPC stub implementing `Disposable`).
 */
export interface NativeArtifactsRepo {
  info(): Promise<RepoInfo>;
  createToken(scope?: TokenScope, ttl?: number): Promise<CreateTokenResult>;
  listTokens(): Promise<TokenListResult>;
  revokeToken(tokenOrId: string): Promise<boolean>;
  fork(name: string, opts?: ForkOptions): Promise<CreateRepoResult>;
  log(opts?: LogOptions): Promise<CommitMetadata[]>;
  readCommit(hash: string): Promise<CommitMetadata | null>;
  readTree(hash: string): Promise<TreeEntry[] | null>;
  readBlob(hash: string): Promise<Blob | null>;
  readFile(args: ReadFileOptions): Promise<Blob | null>;
  [Symbol.dispose]?(): void;
}

/** The native Artifacts namespace binding on the current Workers runtime. */
export interface NativeArtifacts {
  create(name: string, opts?: CreateOptions): Promise<CreateRepoResult>;
  get(name: string): Promise<NativeArtifactsRepo>;
  import(params: ImportOptions): Promise<CreateRepoResult>;
  list(opts?: ListOptions): Promise<RepoListResult>;
  delete(name: string): Promise<boolean>;
}

// ── Errors ───────────────────────────────────────────────────────────────────

/** String error codes thrown by the Artifacts binding. */
export type ArtifactsErrorCode =
  | "ALREADY_EXISTS"
  | "NOT_FOUND"
  | "IMPORT_IN_PROGRESS"
  | "FORK_IN_PROGRESS"
  | "CREATE_IN_PROGRESS"
  | "INVALID_INPUT"
  | "INVALID_REPO_NAME"
  | "INVALID_TTL"
  | "INVALID_URL"
  | "REMOTE_AUTH_REQUIRED"
  | "UPSTREAM_UNAVAILABLE"
  | "MEMORY_LIMIT"
  | "INTERNAL_ERROR";

type ErrorFields = {
  message: string;
  /** Numeric code matching the REST API `errors[].code` (e.g. 10200). */
  numericCode: number | undefined;
  cause: unknown;
};

/** The repository (or, for `import()`, the remote) does not exist (`NOT_FOUND`, 10200). */
export class ArtifactsNotFound extends Data.TaggedError("ArtifactsNotFound")<ErrorFields> {}
/** The target repository already exists (`ALREADY_EXISTS`, 10201). */
export class ArtifactsAlreadyExists extends Data.TaggedError(
  "ArtifactsAlreadyExists",
)<ErrorFields> {}
/** The repository is still being imported (`IMPORT_IN_PROGRESS`, 10302). Retriable. */
export class ArtifactsImportInProgress extends Data.TaggedError(
  "ArtifactsImportInProgress",
)<ErrorFields> {}
/** The repository is still being forked (`FORK_IN_PROGRESS`, 10303). Retriable. */
export class ArtifactsForkInProgress extends Data.TaggedError(
  "ArtifactsForkInProgress",
)<ErrorFields> {}
/** The repository is still being created (`CREATE_IN_PROGRESS`). Retriable. */
export class ArtifactsCreateInProgress extends Data.TaggedError(
  "ArtifactsCreateInProgress",
)<ErrorFields> {}
/** A parameter is missing, malformed, or out of range (`INVALID_INPUT`, 10100). */
export class ArtifactsInvalidInput extends Data.TaggedError("ArtifactsInvalidInput")<ErrorFields> {}
/** The repository name is invalid (`INVALID_REPO_NAME`, 10101). */
export class ArtifactsInvalidRepoName extends Data.TaggedError(
  "ArtifactsInvalidRepoName",
)<ErrorFields> {}
/** The token TTL is outside 60–31536000 seconds (`INVALID_TTL`, 10103). */
export class ArtifactsInvalidTtl extends Data.TaggedError("ArtifactsInvalidTtl")<ErrorFields> {}
/** The import URL is not a valid HTTPS git remote (`INVALID_URL`, 10104). */
export class ArtifactsInvalidUrl extends Data.TaggedError("ArtifactsInvalidUrl")<ErrorFields> {}
/** The import remote requires authentication (`REMOTE_AUTH_REQUIRED`, 10106). */
export class ArtifactsRemoteAuthRequired extends Data.TaggedError(
  "ArtifactsRemoteAuthRequired",
)<ErrorFields> {}
/** The import remote could not be reached (`UPSTREAM_UNAVAILABLE`, 10401). */
export class ArtifactsUpstreamUnavailable extends Data.TaggedError(
  "ArtifactsUpstreamUnavailable",
)<ErrorFields> {}
/** The operation exceeds service memory limits (`MEMORY_LIMIT`, 10402). */
export class ArtifactsMemoryLimit extends Data.TaggedError("ArtifactsMemoryLimit")<ErrorFields> {}
/**
 * An unexpected service error (`INTERNAL_ERROR`, 10400) or any failure the
 * operation does not document.
 */
export class ArtifactsError extends Data.TaggedError("ArtifactsError")<
  ErrorFields & { code: string | undefined }
> {}

/** Maps each documented error code to its tagged error class. */
export interface ArtifactsErrorByCode {
  NOT_FOUND: ArtifactsNotFound;
  ALREADY_EXISTS: ArtifactsAlreadyExists;
  IMPORT_IN_PROGRESS: ArtifactsImportInProgress;
  FORK_IN_PROGRESS: ArtifactsForkInProgress;
  CREATE_IN_PROGRESS: ArtifactsCreateInProgress;
  INVALID_INPUT: ArtifactsInvalidInput;
  INVALID_REPO_NAME: ArtifactsInvalidRepoName;
  INVALID_TTL: ArtifactsInvalidTtl;
  INVALID_URL: ArtifactsInvalidUrl;
  REMOTE_AUTH_REQUIRED: ArtifactsRemoteAuthRequired;
  UPSTREAM_UNAVAILABLE: ArtifactsUpstreamUnavailable;
  MEMORY_LIMIT: ArtifactsMemoryLimit;
  INTERNAL_ERROR: ArtifactsError;
}

/** The typed error union for an operation that documents `Codes`. */
export type ArtifactsErrorFor<Codes extends keyof ArtifactsErrorByCode> =
  | ArtifactsErrorByCode[Codes]
  | ArtifactsError;

const constructors = {
  NOT_FOUND: ArtifactsNotFound,
  ALREADY_EXISTS: ArtifactsAlreadyExists,
  IMPORT_IN_PROGRESS: ArtifactsImportInProgress,
  FORK_IN_PROGRESS: ArtifactsForkInProgress,
  CREATE_IN_PROGRESS: ArtifactsCreateInProgress,
  INVALID_INPUT: ArtifactsInvalidInput,
  INVALID_REPO_NAME: ArtifactsInvalidRepoName,
  INVALID_TTL: ArtifactsInvalidTtl,
  INVALID_URL: ArtifactsInvalidUrl,
  REMOTE_AUTH_REQUIRED: ArtifactsRemoteAuthRequired,
  UPSTREAM_UNAVAILABLE: ArtifactsUpstreamUnavailable,
  MEMORY_LIMIT: ArtifactsMemoryLimit,
} as const;

/**
 * Convert a thrown native `ArtifactsError` into its tagged counterpart. Codes
 * outside `codes` (undocumented for the operation) collapse to the
 * {@link ArtifactsError} catch-all so each method's error union stays honest.
 */
export const toArtifactsError = <Codes extends keyof ArtifactsErrorByCode>(
  error: unknown,
  codes: ReadonlyArray<Codes>,
): ArtifactsErrorFor<Codes> => {
  const e = error as { code?: unknown; numericCode?: unknown; message?: unknown } | undefined;
  const code = typeof e?.code === "string" ? e.code : undefined;
  const fields: ErrorFields = {
    message: typeof e?.message === "string" ? e.message : String(error),
    numericCode: typeof e?.numericCode === "number" ? e.numericCode : undefined,
    cause: error,
  };
  if (
    code !== undefined &&
    code !== "INTERNAL_ERROR" &&
    (codes as ReadonlyArray<string>).includes(code) &&
    code in constructors
  ) {
    const Ctor = constructors[code as keyof typeof constructors];
    return new Ctor(fields) as ArtifactsErrorFor<Codes>;
  }
  return new ArtifactsError({ ...fields, code });
};

/** Run a native Artifacts call, mapping thrown errors via {@link toArtifactsError}. */
export const tryArtifacts = <A, Codes extends keyof ArtifactsErrorByCode = never>(
  fn: () => Promise<A>,
  codes: ReadonlyArray<Codes> = [],
): Effect.Effect<A, ArtifactsErrorFor<Codes>> =>
  Effect.tryPromise({
    try: fn,
    catch: (error) => toArtifactsError(error, codes),
  });

// ── Documented error codes per operation ─────────────────────────────────────

export const CreateRepoErrorCodes = [
  "INVALID_REPO_NAME",
  "INVALID_INPUT",
  "ALREADY_EXISTS",
] as const;
export type CreateRepoError = ArtifactsErrorFor<(typeof CreateRepoErrorCodes)[number]>;

export const GetRepoErrorCodes = [
  "NOT_FOUND",
  "INVALID_REPO_NAME",
  "IMPORT_IN_PROGRESS",
  "FORK_IN_PROGRESS",
  "CREATE_IN_PROGRESS",
] as const;
export type GetRepoError = ArtifactsErrorFor<(typeof GetRepoErrorCodes)[number]>;

export const ImportRepoErrorCodes = [
  "INVALID_REPO_NAME",
  "INVALID_INPUT",
  "INVALID_URL",
  "REMOTE_AUTH_REQUIRED",
  "NOT_FOUND",
  "UPSTREAM_UNAVAILABLE",
  "MEMORY_LIMIT",
  "ALREADY_EXISTS",
] as const;
export type ImportRepoError = ArtifactsErrorFor<(typeof ImportRepoErrorCodes)[number]>;

export const ListReposErrorCodes = ["INVALID_INPUT"] as const;
export type ListReposError = ArtifactsErrorFor<(typeof ListReposErrorCodes)[number]>;

export const DeleteRepoErrorCodes = ["INVALID_REPO_NAME"] as const;
export type DeleteRepoError = ArtifactsErrorFor<(typeof DeleteRepoErrorCodes)[number]>;

export const RepoInfoErrorCodes = ["NOT_FOUND"] as const;
export type RepoInfoError = ArtifactsErrorFor<(typeof RepoInfoErrorCodes)[number]>;

export const CreateTokenErrorCodes = ["INVALID_TTL", "INVALID_INPUT", "NOT_FOUND"] as const;
export type CreateTokenError = ArtifactsErrorFor<(typeof CreateTokenErrorCodes)[number]>;

export const ListTokensErrorCodes = ["NOT_FOUND"] as const;
export type ListTokensError = ArtifactsErrorFor<(typeof ListTokensErrorCodes)[number]>;

export const RevokeTokenErrorCodes = ["INVALID_INPUT"] as const;
export type RevokeTokenError = ArtifactsErrorFor<(typeof RevokeTokenErrorCodes)[number]>;

export const ForkRepoErrorCodes = [
  "INVALID_REPO_NAME",
  "INVALID_INPUT",
  "ALREADY_EXISTS",
  "FORK_IN_PROGRESS",
  "NOT_FOUND",
] as const;
export type ForkRepoError = ArtifactsErrorFor<(typeof ForkRepoErrorCodes)[number]>;

export const ReadObjectErrorCodes = ["INVALID_INPUT", "NOT_FOUND"] as const;
export type ReadObjectError = ArtifactsErrorFor<(typeof ReadObjectErrorCodes)[number]>;

export const ReadBytesErrorCodes = ["INVALID_INPUT", "NOT_FOUND", "MEMORY_LIMIT"] as const;
export type ReadBytesError = ArtifactsErrorFor<(typeof ReadBytesErrorCodes)[number]>;
