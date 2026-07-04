import type {
  DeploymentEvent,
  DeploymentMeta,
  DeploymentOutcome,
  DeploymentRecord,
  DeploymentSummary,
} from "../../State/Deployment.ts";

/**
 * Pure scaffolding for the Cloudflare Durable Object deployment store:
 * reserved key builders, the stored record shapes, and the SQLite
 * statements backing the event journal. Encryption uses the same shared
 * AES-CTR helpers (`Util/aes-ctr.ts`) as resource rows.
 *
 * Shared between `Store.ts` (the stack DO) and its unit tests. Not exported
 * from the `StateStore` index — internal scaffolding only.
 */

/** NUL byte separator — matches `Store.ts`'s composite-key convention. */
const SEP = "\x00";

/**
 * Reserved key prefixes inside a *stack DO*. Deliberately disjoint from the
 * existing `r\x00` (resources), `o\x00` (stack outputs) and `s:` (root stack
 * index) prefixes so deployment history never mixes with resource rows.
 */
export const DEPLOYMENT_RECORD_PREFIX = `d${SEP}`;
/** Open-deployment marker per stage — at most one live open per stage. */
export const DEPLOYMENT_OPEN_PREFIX = `dl${SEP}`;
/** Monotonic per-stage version counter. */
export const DEPLOYMENT_COUNTER_PREFIX = `dc${SEP}`;

/**
 * Zero-pad versions so record keys sort lexicographically in version order,
 * letting `storage.list({ prefix, reverse, end, limit })` implement
 * newest-first pagination without decrypting anything.
 */
const VERSION_PAD = 12;
export const padVersion = (version: number): string =>
  String(version).padStart(VERSION_PAD, "0");

/** Prefix matching every deployment record of a specific stage. */
export const deploymentStagePrefix = (stage: string): string =>
  `${DEPLOYMENT_RECORD_PREFIX}${stage}${SEP}`;

/** Key of one deployment record inside a stack DO. */
export const deploymentRecordKey = (stage: string, version: number): string =>
  `${deploymentStagePrefix(stage)}${padVersion(version)}`;

/** Key of the open-deployment marker for a stage. */
export const deploymentOpenKey = (stage: string): string =>
  `${DEPLOYMENT_OPEN_PREFIX}${stage}`;

/** Key of the per-stage version counter. */
export const deploymentCounterKey = (stage: string): string =>
  `${DEPLOYMENT_COUNTER_PREFIX}${stage}`;

/** Parse an open-marker key back to its stage, or undefined. */
export const parseDeploymentOpenKey = (key: string): string | undefined =>
  key.startsWith(DEPLOYMENT_OPEN_PREFIX)
    ? key.slice(DEPLOYMENT_OPEN_PREFIX.length)
    : undefined;

/** Parse a record key back into `(stage, version)`, or undefined. */
export const parseDeploymentRecordKey = (
  key: string,
): { stage: string; version: number } | undefined => {
  if (!key.startsWith(DEPLOYMENT_RECORD_PREFIX)) return undefined;
  const rest = key.slice(DEPLOYMENT_RECORD_PREFIX.length);
  const sep = rest.lastIndexOf(SEP);
  if (sep < 0) return undefined;
  const version = Number(rest.slice(sep + 1));
  if (!Number.isInteger(version) || version < 1) return undefined;
  return { stage: rest.slice(0, sep), version };
};

// ---------------------------------------------------------------------------
// Stored shapes
// ---------------------------------------------------------------------------

/**
 * The KV value stored under {@link deploymentRecordKey}. Lifecycle /
 * liveness fields stay plaintext so `begin`, `heartbeat` and the alarm can
 * arbitrate without any crypto inside the storage transaction (non-storage
 * awaits there would open the DO input gate mid-claim); the identity-bearing
 * `meta`/`summary` are encrypted with the store's AES-CTR key; the bearer
 * token is stored only as a SHA-256 hash so a storage dump can never mint a
 * valid capability.
 */
export interface StoredDeploymentRecord {
  v: 1;
  stack: string;
  stage: string;
  version: number;
  startedAt: number;
  heartbeatAt: number;
  /** TTL supplied at `begin`, used by the alarm's stale-open detection. */
  ttlMillis: number;
  endedAt?: number;
  outcome?: DeploymentOutcome;
  /** SHA-256 hex of the bearer token — validates ops without decryption. */
  tokenHash: string;
  /** Encrypted {@link DeploymentMeta} (`base64(nonce || ciphertext)`). */
  meta: string;
  /** Encrypted {@link DeploymentSummary}, present once `end` supplied one. */
  summary?: string;
}

/** The KV value stored under {@link deploymentOpenKey}. */
export interface DeploymentOpenMarker {
  version: number;
  /** `heartbeatAt + ttlMillis` at the time of the last write. */
  deadline: number;
}

/**
 * Assemble the public {@link DeploymentRecord} from a stored record and its
 * decrypted meta/summary. Never leaks the token hash, TTL or ciphertext.
 */
export const toPublicDeploymentRecord = (
  stored: StoredDeploymentRecord,
  meta: DeploymentMeta,
  summary?: DeploymentSummary,
): DeploymentRecord => {
  const record: DeploymentRecord = {
    stack: stored.stack,
    stage: stored.stage,
    version: stored.version,
    meta,
    startedAt: stored.startedAt,
    heartbeatAt: stored.heartbeatAt,
  };
  if (stored.endedAt !== undefined) record.endedAt = stored.endedAt;
  if (stored.outcome !== undefined) record.outcome = stored.outcome;
  if (summary !== undefined) record.summary = summary;
  return record;
};

// ---------------------------------------------------------------------------
// DO method result unions
//
// Deployment failures cross the Durable Object RPC boundary as plain
// discriminated values (not thrown tagged errors) — Cloudflare's RPC stub
// serializes thrown errors lossily, so the worker re-raises them as the
// schema-typed HTTP errors instead.
// ---------------------------------------------------------------------------

export type DeploymentBeginResult =
  | { _tag: "ok"; version: number; token: string }
  | { _tag: "in-progress"; holder: DeploymentRecord }
  | { _tag: "corrupt"; message: string };

export type DeploymentMutateResult =
  | { _tag: "ok" }
  | { _tag: "not-found" }
  | { _tag: "invalid-token" };

export type DeploymentAppendResult =
  | { _tag: "ok"; ackedSeq: number }
  | { _tag: "not-found" }
  | { _tag: "invalid-token" };

export type DeploymentGetResult =
  | { _tag: "ok"; record: DeploymentRecord | undefined }
  | { _tag: "corrupt"; message: string };

export type DeploymentListResult =
  | { _tag: "ok"; records: DeploymentRecord[] }
  | { _tag: "corrupt"; message: string };

export type DeploymentReadEventsResult =
  | { _tag: "ok"; events: DeploymentEvent[] }
  | { _tag: "not-found" }
  | { _tag: "corrupt"; message: string };

// ---------------------------------------------------------------------------
// Event journal SQL (storage.sql / SQLite)
//
// Rows escape the 128 KiB per-value KV cap and give indexed range reads.
// `INSERT OR IGNORE` against the composite primary key makes appends
// seq-idempotent for free, so crash-retried batches never duplicate.
// ---------------------------------------------------------------------------

export const CREATE_DEPLOYMENT_EVENTS_TABLE = `CREATE TABLE IF NOT EXISTS deployment_events (
  stage TEXT NOT NULL,
  version INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  fqn TEXT,
  payload TEXT NOT NULL,
  PRIMARY KEY (stage, version, seq)
)`;

export const INSERT_DEPLOYMENT_EVENT = `INSERT OR IGNORE INTO deployment_events (stage, version, seq, ts, fqn, payload) VALUES (?, ?, ?, ?, ?, ?)`;

export const SELECT_DEPLOYMENT_MAX_SEQ = `SELECT COALESCE(MAX(seq), 0) AS ackedSeq FROM deployment_events WHERE stage = ? AND version = ?`;

export const selectDeploymentEventsSql = (hasFromSeq: boolean): string =>
  `SELECT seq, ts, fqn, payload FROM deployment_events WHERE stage = ? AND version = ?${hasFromSeq ? " AND seq >= ?" : ""} ORDER BY seq ASC`;

/** Row shape of the `deployment_events` table. */
export interface DeploymentEventRow extends Record<
  string,
  string | number | null
> {
  seq: number;
  ts: number;
  fqn: string | null;
  /** Encrypted event payload (`base64(nonce || ciphertext)`). */
  payload: string;
}
