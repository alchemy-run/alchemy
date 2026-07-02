import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type {
  DeploymentEvent,
  DeploymentMeta,
  DeploymentOutcome,
  DeploymentRecord,
  DeploymentSummary,
} from "../../State/Deployment.ts";

/**
 * Pure scaffolding for the Cloudflare Durable Object deployment store:
 * reserved key builders, the stale-open predicate, the sealed
 * (AES-CTR-encrypted + SHA-256-integrity-hashed) codec for deployment
 * records/payloads, and the SQLite statements backing the event journal.
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

/**
 * An open deployment whose heartbeat is at least `ttlMillis` old is stale
 * and gets reconciled to `"abandoned"` (by the next `begin` and by the DO
 * alarm). `ttlMillis: 0` therefore means "always stale".
 */
export const isStaleOpen = (
  record: { heartbeatAt: number },
  now: number,
  ttlMillis: number,
): boolean => now - record.heartbeatAt >= ttlMillis;

// ---------------------------------------------------------------------------
// Sealed codec — AES-CTR encryption + SHA-256 integrity hash
// ---------------------------------------------------------------------------

/**
 * Deployment data that fails to decrypt or fails its integrity check.
 *
 * Unlike resource rows (which historically swallow decryption failures and
 * return `undefined` so the engine can reconcile), deployment history is
 * read-only evidence — silently dropping it would be indistinguishable from
 * "never happened", so corruption surfaces as this typed error instead.
 */
export class DeploymentDataCorrupt extends Data.TaggedError(
  "DeploymentDataCorrupt",
)<{
  message: string;
}> {}

/**
 * Encrypted-at-rest framing: `data` is base64(nonce || ciphertext) using the
 * same AES-CTR scheme as resource rows; `hash` is the SHA-256 hex digest of
 * the plaintext JSON, verified on open.
 */
export interface SealedBox {
  readonly hash: string;
  readonly data: string;
}

/** AES-CTR counter block length (same as `Store.ts`). */
const NONCE_BYTES = 16;

/**
 * Allocate a `Uint8Array` over a fresh `ArrayBuffer` (not shared) so the
 * buffer satisfies Web Crypto's `BufferSource` under strict DOM typings.
 */
const allocBytes = (size: number): Uint8Array<ArrayBuffer> =>
  new Uint8Array(new ArrayBuffer(size));

/** Copy arbitrary bytes into a fresh non-shared buffer for Web Crypto. */
const toBufferSource = (bytes: Uint8Array): Uint8Array<ArrayBuffer> => {
  const copy = allocBytes(bytes.byteLength);
  copy.set(bytes);
  return copy;
};

/** SHA-256 hex digest of a string or byte payload. */
export const sha256Hex = (input: string | Uint8Array): Effect.Effect<string> =>
  Effect.promise(async () => {
    const bytes =
      typeof input === "string" ? new TextEncoder().encode(input) : input;
    const digest = await crypto.subtle.digest("SHA-256", toBufferSource(bytes));
    return Buffer.from(digest).toString("hex");
  });

/**
 * Import a hex-encoded 256-bit key as the AES-CTR `CryptoKey` used to seal
 * deployment data. Same key material as the resource-row encryption key.
 */
export const importDeploymentKey = (keyHex: string): Effect.Effect<CryptoKey> =>
  Effect.promise(() =>
    crypto.subtle.importKey(
      "raw",
      Buffer.from(keyHex, "hex"),
      { name: "AES-CTR" },
      false,
      ["encrypt", "decrypt"],
    ),
  );

export interface DeploymentCrypto {
  /** Encrypt a JSON-serializable value and record its integrity hash. */
  seal(value: unknown): Effect.Effect<SealedBox>;
  /** Decrypt + verify a sealed value; typed failure on any mismatch. */
  open<T>(box: SealedBox): Effect.Effect<T, DeploymentDataCorrupt>;
}

export const makeDeploymentCrypto = (
  cryptoKey: CryptoKey,
): DeploymentCrypto => ({
  seal: (value) =>
    Effect.gen(function* () {
      const plaintext = new TextEncoder().encode(JSON.stringify(value));
      const hash = yield* sha256Hex(plaintext);
      const data = yield* Effect.promise(async () => {
        const counter = crypto.getRandomValues(allocBytes(NONCE_BYTES));
        const ciphertext = new Uint8Array(
          await crypto.subtle.encrypt(
            { name: "AES-CTR", counter, length: 64 },
            cryptoKey,
            toBufferSource(plaintext),
          ),
        );
        return Buffer.concat([counter, ciphertext]).toString("base64");
      });
      return { hash, data };
    }),
  open: <T>(box: SealedBox) =>
    Effect.gen(function* () {
      const plaintext = yield* Effect.tryPromise({
        try: async () => {
          const framed = Buffer.from(box.data, "base64");
          const counter = toBufferSource(framed.subarray(0, NONCE_BYTES));
          const ciphertext = toBufferSource(framed.subarray(NONCE_BYTES));
          const decrypted = await crypto.subtle.decrypt(
            { name: "AES-CTR", counter, length: 64 },
            cryptoKey,
            ciphertext,
          );
          return new Uint8Array(decrypted);
        },
        catch: (cause) =>
          new DeploymentDataCorrupt({
            message: `deployment data failed to decrypt: ${String(cause)}`,
          }),
      });
      const hash = yield* sha256Hex(plaintext);
      if (hash !== box.hash) {
        return yield* Effect.fail(
          new DeploymentDataCorrupt({
            message: "deployment data integrity hash mismatch",
          }),
        );
      }
      return yield* Effect.try({
        try: () => JSON.parse(new TextDecoder().decode(plaintext)) as T,
        catch: () =>
          new DeploymentDataCorrupt({
            message: "deployment data is not valid JSON",
          }),
      });
    }),
});

// ---------------------------------------------------------------------------
// Stored shapes
// ---------------------------------------------------------------------------

/**
 * The KV value stored under {@link deploymentRecordKey}. Lifecycle /
 * liveness fields stay plaintext so `begin`, `heartbeat` and the alarm can
 * arbitrate without any crypto inside the storage transaction (non-storage
 * awaits there would open the DO input gate mid-claim); the identity-bearing
 * `meta`/`summary` are sealed; the bearer token is stored only as a SHA-256
 * hash so a storage dump can never mint a valid capability.
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
  /** Sealed {@link DeploymentMeta}. */
  meta: SealedBox;
  /** Sealed {@link DeploymentSummary}, present once `end` supplied one. */
  summary?: SealedBox;
}

/** The KV value stored under {@link deploymentOpenKey}. */
export interface DeploymentOpenMarker {
  version: number;
  /** `heartbeatAt + ttlMillis` at the time of the last write. */
  deadline: number;
}

/**
 * Assemble the public {@link DeploymentRecord} from a stored record and its
 * unsealed meta/summary. Never leaks the token hash, TTL or sealed boxes.
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
  hash TEXT NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (stage, version, seq)
)`;

export const INSERT_DEPLOYMENT_EVENT = `INSERT OR IGNORE INTO deployment_events (stage, version, seq, ts, fqn, hash, payload) VALUES (?, ?, ?, ?, ?, ?, ?)`;

export const SELECT_DEPLOYMENT_MAX_SEQ = `SELECT COALESCE(MAX(seq), 0) AS ackedSeq FROM deployment_events WHERE stage = ? AND version = ?`;

export const selectDeploymentEventsSql = (hasFromSeq: boolean): string =>
  `SELECT seq, ts, fqn, hash, payload FROM deployment_events WHERE stage = ? AND version = ?${hasFromSeq ? " AND seq >= ?" : ""} ORDER BY seq ASC`;

/** Row shape of the `deployment_events` table. */
export interface DeploymentEventRow extends Record<
  string,
  string | number | null
> {
  seq: number;
  ts: number;
  fqn: string | null;
  hash: string;
  payload: string;
}
