/**
 * Schema values for Celld's object-storage and signed-operator contracts.
 * `@distilled.cloud/celld/runtime` exports their types and the HTTP
 * operations, but not standalone shape schemas; Alchemy decodes and
 * validates the bucket artifacts with these.
 *
 * @internal
 */
import * as S from "@distilled.cloud/core/schema";
import * as T from "@distilled.cloud/core/trait";

export * from "@distilled.cloud/celld/runtime";

/** The native D1 engine rejected SQL execution. Exec and prepared-statement requests may have already committed earlier statements; this error does not authorize automatic mutation replay. */
/** peer protocol version is incompatible */
/** peer request replay rejected */
/** peer request targets a different node session */
export type KvDeleteOperation = "delete";
export const KvDeleteOperation = S.String;

export type Strings = Array<string>;
export const Strings = /*@__PURE__*/ S.Array(S.String) as any as S.Schema<Strings>;

export interface DeleteKvInput {
  /** Reserved-class cell scope derived by Celld, not a database, namespace or queue display name. */
  scope: string;
  /** Optional cell identity name; include the exact encoded query string in the peer signature. */
  name?: string;
  /** Peer protocol version; send the string 5. */
  peer_version: string;
  /** Source node name or operator identity, validated as a node name. */
  peer_source: string;
  /** Exact addressed node session identity, not the cell scope. */
  peer_target: string;
  /** Decimal Unix milliseconds as text; accepted within a 30000 ms clock window. */
  peer_timestamp: string;
  /** A fresh 16-byte nonce encoded as 32 hexadecimal characters; reuse is rejected. */
  peer_nonce: string;
  /** Lowercase SHA-256 hex digest of the exact serialized HTTP request body bytes. */
  peer_body_sha256: string;
  /** HMAC-SHA256 hex signature over newline-separated domain cells-peer-request-v1, version 5, method POST, exact path and query, body hash, source, target, timestamp and nonce, with no trailing newline. */
  peer_signature: string;
  op: KvDeleteOperation | (string & {});
  keys: Strings;
}
export const DeleteKvInput = /*@__PURE__*/ S.suspend(() =>
  S.Struct({
    scope: S.String.pipe(T.Label(), T.LabelEncoding({ preserve: ":$" })),
    name: S.optional(S.String.pipe(T.Query())),
    peer_version: S.String.pipe(T.Header("x-cells-peer-version")),
    peer_source: S.String.pipe(T.Header("x-cells-peer-source")),
    peer_target: S.String.pipe(T.Header("x-cells-peer-target")),
    peer_timestamp: S.String.pipe(T.Header("x-cells-peer-timestamp")),
    peer_nonce: S.String.pipe(T.Header("x-cells-peer-nonce")),
    peer_body_sha256: S.String.pipe(T.Header("x-cells-peer-body-sha256")),
    peer_signature: S.String.pipe(T.Header("x-cells-peer-signature")),
    op: KvDeleteOperation,
    keys: Strings,
  }).pipe(T.Http({ method: "POST", uri: "/runtime/{scope}", code: 200 })),
).annotate({ identifier: "DeleteKvInput" }) as any as S.Schema<DeleteKvInput>;

export interface OkResult {
  ok: boolean;
}
export const OkResult = /*@__PURE__*/ S.suspend(() =>
  S.Struct({
    ok: S.Boolean,
  }),
).annotate({ identifier: "OkResult" }) as any as S.Schema<OkResult>;

/** The actual HTTP JSON envelope is {"result": ...}; nested arrays or scalars are not top-level raw responses. */
export interface DeleteKvOutput {
  result: OkResult;
}
export const DeleteKvOutput = /*@__PURE__*/ S.suspend(() =>
  S.Struct({
    result: OkResult,
  }),
).annotate({ identifier: "DeleteKvOutput" }) as any as S.Schema<DeleteKvOutput>;

export interface D1ExecPayload {
  sql: string;
  rows?: boolean;
}
export const D1ExecPayload = /*@__PURE__*/ S.suspend(() =>
  S.Struct({
    sql: S.String,
    rows: S.optional(S.Boolean),
  }),
).annotate({ identifier: "D1ExecPayload" }) as any as S.Schema<D1ExecPayload>;

export interface ExecD1Input {
  /** Reserved-class cell scope derived by Celld, not a database, namespace or queue display name. */
  scope: string;
  /** Optional cell identity name; include the exact encoded query string in the peer signature. */
  name?: string;
  /** Peer protocol version; send the string 5. */
  peer_version: string;
  /** Source node name or operator identity, validated as a node name. */
  peer_source: string;
  /** Exact addressed node session identity, not the cell scope. */
  peer_target: string;
  /** Decimal Unix milliseconds as text; accepted within a 30000 ms clock window. */
  peer_timestamp: string;
  /** A fresh 16-byte nonce encoded as 32 hexadecimal characters; reuse is rejected. */
  peer_nonce: string;
  /** Lowercase SHA-256 hex digest of the exact serialized HTTP request body bytes. */
  peer_body_sha256: string;
  /** HMAC-SHA256 hex signature over newline-separated domain cells-peer-request-v1, version 5, method POST, exact path and query, body hash, source, target, timestamp and nonce, with no trailing newline. */
  peer_signature: string;
  exec: D1ExecPayload;
}
export const ExecD1Input = /*@__PURE__*/ S.suspend(() =>
  S.Struct({
    scope: S.String.pipe(T.Label(), T.LabelEncoding({ preserve: ":$" })),
    name: S.optional(S.String.pipe(T.Query())),
    peer_version: S.String.pipe(T.Header("x-cells-peer-version")),
    peer_source: S.String.pipe(T.Header("x-cells-peer-source")),
    peer_target: S.String.pipe(T.Header("x-cells-peer-target")),
    peer_timestamp: S.String.pipe(T.Header("x-cells-peer-timestamp")),
    peer_nonce: S.String.pipe(T.Header("x-cells-peer-nonce")),
    peer_body_sha256: S.String.pipe(T.Header("x-cells-peer-body-sha256")),
    peer_signature: S.String.pipe(T.Header("x-cells-peer-signature")),
    exec: D1ExecPayload,
  }).pipe(T.Http({ method: "POST", uri: "/runtime/{scope}", code: 200 })),
).annotate({ identifier: "ExecD1Input" }) as any as S.Schema<ExecD1Input>;

export type JsonValues = Array<unknown>;
export const JsonValues = /*@__PURE__*/ S.Array(S.Unknown) as any as S.Schema<JsonValues>;

export type Rows = Array<JsonValues>;
export const Rows = /*@__PURE__*/ S.Array(JsonValues) as any as S.Schema<Rows>;

/** Native SQL engine result; row values and engine metadata retain their JSON types. */
export interface D1ResultSet {
  columns?: Strings;
  rows?: Rows;
  meta?: unknown;
}
export const D1ResultSet = /*@__PURE__*/ S.suspend(() =>
  S.Struct({
    columns: S.optional(Strings),
    rows: S.optional(Rows),
    meta: S.optional(S.Unknown),
  }),
).annotate({ identifier: "D1ResultSet" }) as any as S.Schema<D1ResultSet>;

export type D1ResultSets = Array<D1ResultSet>;
export const D1ResultSets = /*@__PURE__*/ S.Array(D1ResultSet) as any as S.Schema<D1ResultSets>;

/** Duration is in milliseconds. Result sets are present only when exec.rows is true. */
export interface ExecD1Result {
  count: number;
  duration: number;
  results?: D1ResultSets;
}
export const ExecD1Result = /*@__PURE__*/ S.suspend(() =>
  S.Struct({
    count: S.Number,
    duration: S.Number,
    results: S.optional(D1ResultSets),
  }),
).annotate({ identifier: "ExecD1Result" }) as any as S.Schema<ExecD1Result>;

/** The actual HTTP JSON envelope is {"result": ...}; nested arrays or scalars are not top-level raw responses. */
export interface ExecD1Output {
  result: ExecD1Result;
}
export const ExecD1Output = /*@__PURE__*/ S.suspend(() =>
  S.Struct({
    result: ExecD1Result,
  }),
).annotate({ identifier: "ExecD1Output" }) as any as S.Schema<ExecD1Output>;

export interface D1Statement {
  sql: string;
  params?: JsonValues;
  first?: boolean;
}
export const D1Statement = /*@__PURE__*/ S.suspend(() =>
  S.Struct({
    sql: S.String,
    params: S.optional(JsonValues),
    first: S.optional(S.Boolean),
  }),
).annotate({ identifier: "D1Statement" }) as any as S.Schema<D1Statement>;

export type D1StatementList = Array<D1Statement>;
export const D1StatementList = /*@__PURE__*/ S.Array(
  D1Statement,
) as any as S.Schema<D1StatementList>;

export interface ExecuteD1StatementsInput {
  /** Reserved-class cell scope derived by Celld, not a database, namespace or queue display name. */
  scope: string;
  /** Optional cell identity name; include the exact encoded query string in the peer signature. */
  name?: string;
  /** Peer protocol version; send the string 5. */
  peer_version: string;
  /** Source node name or operator identity, validated as a node name. */
  peer_source: string;
  /** Exact addressed node session identity, not the cell scope. */
  peer_target: string;
  /** Decimal Unix milliseconds as text; accepted within a 30000 ms clock window. */
  peer_timestamp: string;
  /** A fresh 16-byte nonce encoded as 32 hexadecimal characters; reuse is rejected. */
  peer_nonce: string;
  /** Lowercase SHA-256 hex digest of the exact serialized HTTP request body bytes. */
  peer_body_sha256: string;
  /** HMAC-SHA256 hex signature over newline-separated domain cells-peer-request-v1, version 5, method POST, exact path and query, body hash, source, target, timestamp and nonce, with no trailing newline. */
  peer_signature: string;
  statements: D1StatementList;
}
export const ExecuteD1StatementsInput = /*@__PURE__*/ S.suspend(() =>
  S.Struct({
    scope: S.String.pipe(T.Label(), T.LabelEncoding({ preserve: ":$" })),
    name: S.optional(S.String.pipe(T.Query())),
    peer_version: S.String.pipe(T.Header("x-cells-peer-version")),
    peer_source: S.String.pipe(T.Header("x-cells-peer-source")),
    peer_target: S.String.pipe(T.Header("x-cells-peer-target")),
    peer_timestamp: S.String.pipe(T.Header("x-cells-peer-timestamp")),
    peer_nonce: S.String.pipe(T.Header("x-cells-peer-nonce")),
    peer_body_sha256: S.String.pipe(T.Header("x-cells-peer-body-sha256")),
    peer_signature: S.String.pipe(T.Header("x-cells-peer-signature")),
    statements: D1StatementList,
  }).pipe(T.Http({ method: "POST", uri: "/runtime/{scope}", code: 200 })),
).annotate({
  identifier: "ExecuteD1StatementsInput",
}) as any as S.Schema<ExecuteD1StatementsInput>;

/** The actual HTTP JSON envelope is {"result": ...}; nested arrays or scalars are not top-level raw responses. */
export interface ExecuteD1StatementsOutput {
  result: D1ResultSets;
}
export const ExecuteD1StatementsOutput = /*@__PURE__*/ S.suspend(() =>
  S.Struct({
    result: D1ResultSets,
  }),
).annotate({
  identifier: "ExecuteD1StatementsOutput",
}) as any as S.Schema<ExecuteD1StatementsOutput>;

export type KvGetOperation = "get";
export const KvGetOperation = S.String;

export interface GetKvInput {
  /** Reserved-class cell scope derived by Celld, not a database, namespace or queue display name. */
  scope: string;
  /** Optional cell identity name; include the exact encoded query string in the peer signature. */
  name?: string;
  /** Peer protocol version; send the string 5. */
  peer_version: string;
  /** Source node name or operator identity, validated as a node name. */
  peer_source: string;
  /** Exact addressed node session identity, not the cell scope. */
  peer_target: string;
  /** Decimal Unix milliseconds as text; accepted within a 30000 ms clock window. */
  peer_timestamp: string;
  /** A fresh 16-byte nonce encoded as 32 hexadecimal characters; reuse is rejected. */
  peer_nonce: string;
  /** Lowercase SHA-256 hex digest of the exact serialized HTTP request body bytes. */
  peer_body_sha256: string;
  /** HMAC-SHA256 hex signature over newline-separated domain cells-peer-request-v1, version 5, method POST, exact path and query, body hash, source, target, timestamp and nonce, with no trailing newline. */
  peer_signature: string;
  op: KvGetOperation | (string & {});
  key: string;
}
export const GetKvInput = /*@__PURE__*/ S.suspend(() =>
  S.Struct({
    scope: S.String.pipe(T.Label(), T.LabelEncoding({ preserve: ":$" })),
    name: S.optional(S.String.pipe(T.Query())),
    peer_version: S.String.pipe(T.Header("x-cells-peer-version")),
    peer_source: S.String.pipe(T.Header("x-cells-peer-source")),
    peer_target: S.String.pipe(T.Header("x-cells-peer-target")),
    peer_timestamp: S.String.pipe(T.Header("x-cells-peer-timestamp")),
    peer_nonce: S.String.pipe(T.Header("x-cells-peer-nonce")),
    peer_body_sha256: S.String.pipe(T.Header("x-cells-peer-body-sha256")),
    peer_signature: S.String.pipe(T.Header("x-cells-peer-signature")),
    op: KvGetOperation,
    key: S.String,
  }).pipe(T.Http({ method: "POST", uri: "/runtime/{scope}", code: 200 })),
).annotate({ identifier: "GetKvInput" }) as any as S.Schema<GetKvInput>;

export interface GetKvResult {
  found: boolean;
  /** A JSON array of byte integers for inline values, or a base64 string for large values. Absent when found is false. */
  value?: unknown;
  /** base64 for large values; absent for inline byte arrays. */
  value_encoding?: string;
  tag?: string;
  /** Stored JSON text, not a decoded metadata object. May be null. */
  metadata?: string | null;
  /** Expiration in Unix milliseconds; may be null. */
  expiration?: number | null;
}
export const GetKvResult = /*@__PURE__*/ S.suspend(() =>
  S.Struct({
    found: S.Boolean,
    value: S.optional(S.Unknown),
    value_encoding: S.optional(S.String.pipe(T.Body("valueEncoding"))),
    tag: S.optional(S.String),
    metadata: S.optional(S.NullOr(S.String)),
    expiration: S.optional(S.NullOr(S.Number)),
  }),
).annotate({ identifier: "GetKvResult" }) as any as S.Schema<GetKvResult>;

/** The actual HTTP JSON envelope is {"result": ...}; nested arrays or scalars are not top-level raw responses. */
export interface GetKvOutput {
  result: GetKvResult;
}
export const GetKvOutput = /*@__PURE__*/ S.suspend(() =>
  S.Struct({
    result: GetKvResult,
  }),
).annotate({ identifier: "GetKvOutput" }) as any as S.Schema<GetKvOutput>;

export type GetKvInfoOperation = "info";
export const GetKvInfoOperation = S.String;

export interface GetKvInfoInput {
  /** Reserved-class cell scope derived by Celld, not a database, namespace or queue display name. */
  scope: string;
  /** Optional cell identity name; include the exact encoded query string in the peer signature. */
  name?: string;
  /** Peer protocol version; send the string 5. */
  peer_version: string;
  /** Source node name or operator identity, validated as a node name. */
  peer_source: string;
  /** Exact addressed node session identity, not the cell scope. */
  peer_target: string;
  /** Decimal Unix milliseconds as text; accepted within a 30000 ms clock window. */
  peer_timestamp: string;
  /** A fresh 16-byte nonce encoded as 32 hexadecimal characters; reuse is rejected. */
  peer_nonce: string;
  /** Lowercase SHA-256 hex digest of the exact serialized HTTP request body bytes. */
  peer_body_sha256: string;
  /** HMAC-SHA256 hex signature over newline-separated domain cells-peer-request-v1, version 5, method POST, exact path and query, body hash, source, target, timestamp and nonce, with no trailing newline. */
  peer_signature: string;
  op: GetKvInfoOperation | (string & {});
}
export const GetKvInfoInput = /*@__PURE__*/ S.suspend(() =>
  S.Struct({
    scope: S.String.pipe(T.Label(), T.LabelEncoding({ preserve: ":$" })),
    name: S.optional(S.String.pipe(T.Query())),
    peer_version: S.String.pipe(T.Header("x-cells-peer-version")),
    peer_source: S.String.pipe(T.Header("x-cells-peer-source")),
    peer_target: S.String.pipe(T.Header("x-cells-peer-target")),
    peer_timestamp: S.String.pipe(T.Header("x-cells-peer-timestamp")),
    peer_nonce: S.String.pipe(T.Header("x-cells-peer-nonce")),
    peer_body_sha256: S.String.pipe(T.Header("x-cells-peer-body-sha256")),
    peer_signature: S.String.pipe(T.Header("x-cells-peer-signature")),
    op: GetKvInfoOperation,
  }).pipe(T.Http({ method: "POST", uri: "/runtime/{scope}", code: 200 })),
).annotate({ identifier: "GetKvInfoInput" }) as any as S.Schema<GetKvInfoInput>;

export interface GetKvInfoResult {
  live: number;
  bytes: number;
  stored: number;
}
export const GetKvInfoResult = /*@__PURE__*/ S.suspend(() =>
  S.Struct({
    live: S.Number,
    bytes: S.Number,
    stored: S.Number,
  }),
).annotate({
  identifier: "GetKvInfoResult",
}) as any as S.Schema<GetKvInfoResult>;

/** The actual HTTP JSON envelope is {"result": ...}; nested arrays or scalars are not top-level raw responses. */
export interface GetKvInfoOutput {
  result: GetKvInfoResult;
}
export const GetKvInfoOutput = /*@__PURE__*/ S.suspend(() =>
  S.Struct({
    result: GetKvInfoResult,
  }),
).annotate({
  identifier: "GetKvInfoOutput",
}) as any as S.Schema<GetKvInfoOutput>;

export type GetQueueInfoOperation = "info";
export const GetQueueInfoOperation = S.String;

export interface GetQueueInfoInput {
  /** Reserved-class cell scope derived by Celld, not a database, namespace or queue display name. */
  scope: string;
  /** Optional cell identity name; include the exact encoded query string in the peer signature. */
  name?: string;
  /** Peer protocol version; send the string 5. */
  peer_version: string;
  /** Source node name or operator identity, validated as a node name. */
  peer_source: string;
  /** Exact addressed node session identity, not the cell scope. */
  peer_target: string;
  /** Decimal Unix milliseconds as text; accepted within a 30000 ms clock window. */
  peer_timestamp: string;
  /** A fresh 16-byte nonce encoded as 32 hexadecimal characters; reuse is rejected. */
  peer_nonce: string;
  /** Lowercase SHA-256 hex digest of the exact serialized HTTP request body bytes. */
  peer_body_sha256: string;
  /** HMAC-SHA256 hex signature over newline-separated domain cells-peer-request-v1, version 5, method POST, exact path and query, body hash, source, target, timestamp and nonce, with no trailing newline. */
  peer_signature: string;
  op: GetQueueInfoOperation | (string & {});
}
export const GetQueueInfoInput = /*@__PURE__*/ S.suspend(() =>
  S.Struct({
    scope: S.String.pipe(T.Label(), T.LabelEncoding({ preserve: ":$" })),
    name: S.optional(S.String.pipe(T.Query())),
    peer_version: S.String.pipe(T.Header("x-cells-peer-version")),
    peer_source: S.String.pipe(T.Header("x-cells-peer-source")),
    peer_target: S.String.pipe(T.Header("x-cells-peer-target")),
    peer_timestamp: S.String.pipe(T.Header("x-cells-peer-timestamp")),
    peer_nonce: S.String.pipe(T.Header("x-cells-peer-nonce")),
    peer_body_sha256: S.String.pipe(T.Header("x-cells-peer-body-sha256")),
    peer_signature: S.String.pipe(T.Header("x-cells-peer-signature")),
    op: GetQueueInfoOperation,
  }).pipe(T.Http({ method: "POST", uri: "/runtime/{scope}", code: 200 })),
).annotate({
  identifier: "GetQueueInfoInput",
}) as any as S.Schema<GetQueueInfoInput>;

export interface GetQueueInfoResult {
  backlog_count: number;
  backlog_bytes: number;
  /** Unix milliseconds; null when no message exists. */
  oldest_message_timestamp?: number | null;
  stored: number;
  paused: boolean;
}
export const GetQueueInfoResult = /*@__PURE__*/ S.suspend(() =>
  S.Struct({
    backlog_count: S.Number.pipe(T.Body("backlogCount")),
    backlog_bytes: S.Number.pipe(T.Body("backlogBytes")),
    oldest_message_timestamp: S.optional(S.NullOr(S.Number).pipe(T.Body("oldestMessageTimestamp"))),
    stored: S.Number,
    paused: S.Boolean,
  }),
).annotate({
  identifier: "GetQueueInfoResult",
}) as any as S.Schema<GetQueueInfoResult>;

/** The actual HTTP JSON envelope is {"result": ...}; nested arrays or scalars are not top-level raw responses. */
export interface GetQueueInfoOutput {
  result: GetQueueInfoResult;
}
export const GetQueueInfoOutput = /*@__PURE__*/ S.suspend(() =>
  S.Struct({
    result: GetQueueInfoResult,
  }),
).annotate({
  identifier: "GetQueueInfoOutput",
}) as any as S.Schema<GetQueueInfoOutput>;

export type KvListOperation = "list";
export const KvListOperation = S.String;

export interface ListKvInput {
  /** Reserved-class cell scope derived by Celld, not a database, namespace or queue display name. */
  scope: string;
  /** Optional cell identity name; include the exact encoded query string in the peer signature. */
  name?: string;
  /** Peer protocol version; send the string 5. */
  peer_version: string;
  /** Source node name or operator identity, validated as a node name. */
  peer_source: string;
  /** Exact addressed node session identity, not the cell scope. */
  peer_target: string;
  /** Decimal Unix milliseconds as text; accepted within a 30000 ms clock window. */
  peer_timestamp: string;
  /** A fresh 16-byte nonce encoded as 32 hexadecimal characters; reuse is rejected. */
  peer_nonce: string;
  /** Lowercase SHA-256 hex digest of the exact serialized HTTP request body bytes. */
  peer_body_sha256: string;
  /** HMAC-SHA256 hex signature over newline-separated domain cells-peer-request-v1, version 5, method POST, exact path and query, body hash, source, target, timestamp and nonce, with no trailing newline. */
  peer_signature: string;
  op: KvListOperation | (string & {});
  prefix?: string;
  limit: number;
  /** Exclusive last key name from the previous page, not a binding cursor. */
  after?: string;
}
export const ListKvInput = /*@__PURE__*/ S.suspend(() =>
  S.Struct({
    scope: S.String.pipe(T.Label(), T.LabelEncoding({ preserve: ":$" })),
    name: S.optional(S.String.pipe(T.Query())),
    peer_version: S.String.pipe(T.Header("x-cells-peer-version")),
    peer_source: S.String.pipe(T.Header("x-cells-peer-source")),
    peer_target: S.String.pipe(T.Header("x-cells-peer-target")),
    peer_timestamp: S.String.pipe(T.Header("x-cells-peer-timestamp")),
    peer_nonce: S.String.pipe(T.Header("x-cells-peer-nonce")),
    peer_body_sha256: S.String.pipe(T.Header("x-cells-peer-body-sha256")),
    peer_signature: S.String.pipe(T.Header("x-cells-peer-signature")),
    op: KvListOperation,
    prefix: S.optional(S.String),
    limit: S.Number,
    after: S.optional(S.String),
  }).pipe(T.Http({ method: "POST", uri: "/runtime/{scope}", code: 200 })),
).annotate({ identifier: "ListKvInput" }) as any as S.Schema<ListKvInput>;

export interface KvKey {
  name: string;
  /** Stored JSON text; may be null. */
  metadata?: string | null;
  /** Unix milliseconds; may be null. */
  expiration?: number | null;
}
export const KvKey = /*@__PURE__*/ S.suspend(() =>
  S.Struct({
    name: S.String,
    metadata: S.optional(S.NullOr(S.String)),
    expiration: S.optional(S.NullOr(S.Number)),
  }),
).annotate({ identifier: "KvKey" }) as any as S.Schema<KvKey>;

export type KvKeys = Array<KvKey>;
export const KvKeys = /*@__PURE__*/ S.Array(KvKey) as any as S.Schema<KvKeys>;

export interface ListKvResult {
  keys: KvKeys;
  complete: boolean;
}
export const ListKvResult = /*@__PURE__*/ S.suspend(() =>
  S.Struct({
    keys: KvKeys,
    complete: S.Boolean,
  }),
).annotate({ identifier: "ListKvResult" }) as any as S.Schema<ListKvResult>;

/** The actual HTTP JSON envelope is {"result": ...}; nested arrays or scalars are not top-level raw responses. */
export interface ListKvOutput {
  result: ListKvResult;
}
export const ListKvOutput = /*@__PURE__*/ S.suspend(() =>
  S.Struct({
    result: ListKvResult,
  }),
).annotate({ identifier: "ListKvOutput" }) as any as S.Schema<ListKvOutput>;

export interface D1Migration {
  name: string;
  sql: string;
  /** Defaults to d1_migrations when omitted or empty. */
  table?: string;
}
export const D1Migration = /*@__PURE__*/ S.suspend(() =>
  S.Struct({
    name: S.String,
    sql: S.String,
    table: S.optional(S.String),
  }),
).annotate({ identifier: "D1Migration" }) as any as S.Schema<D1Migration>;

export interface MigrateD1Input {
  /** Reserved-class cell scope derived by Celld, not a database, namespace or queue display name. */
  scope: string;
  /** Optional cell identity name; include the exact encoded query string in the peer signature. */
  name?: string;
  /** Peer protocol version; send the string 5. */
  peer_version: string;
  /** Source node name or operator identity, validated as a node name. */
  peer_source: string;
  /** Exact addressed node session identity, not the cell scope. */
  peer_target: string;
  /** Decimal Unix milliseconds as text; accepted within a 30000 ms clock window. */
  peer_timestamp: string;
  /** A fresh 16-byte nonce encoded as 32 hexadecimal characters; reuse is rejected. */
  peer_nonce: string;
  /** Lowercase SHA-256 hex digest of the exact serialized HTTP request body bytes. */
  peer_body_sha256: string;
  /** HMAC-SHA256 hex signature over newline-separated domain cells-peer-request-v1, version 5, method POST, exact path and query, body hash, source, target, timestamp and nonce, with no trailing newline. */
  peer_signature: string;
  migrate: D1Migration;
}
export const MigrateD1Input = /*@__PURE__*/ S.suspend(() =>
  S.Struct({
    scope: S.String.pipe(T.Label(), T.LabelEncoding({ preserve: ":$" })),
    name: S.optional(S.String.pipe(T.Query())),
    peer_version: S.String.pipe(T.Header("x-cells-peer-version")),
    peer_source: S.String.pipe(T.Header("x-cells-peer-source")),
    peer_target: S.String.pipe(T.Header("x-cells-peer-target")),
    peer_timestamp: S.String.pipe(T.Header("x-cells-peer-timestamp")),
    peer_nonce: S.String.pipe(T.Header("x-cells-peer-nonce")),
    peer_body_sha256: S.String.pipe(T.Header("x-cells-peer-body-sha256")),
    peer_signature: S.String.pipe(T.Header("x-cells-peer-signature")),
    migrate: D1Migration,
  }).pipe(T.Http({ method: "POST", uri: "/runtime/{scope}", code: 200 })),
).annotate({ identifier: "MigrateD1Input" }) as any as S.Schema<MigrateD1Input>;

/** The actual HTTP JSON envelope is {"result": ...}; nested arrays or scalars are not top-level raw responses. */
export interface MigrateD1Output {
  result: unknown;
}
export const MigrateD1Output = /*@__PURE__*/ S.suspend(() =>
  S.Struct({
    result: S.Unknown,
  }),
).annotate({
  identifier: "MigrateD1Output",
}) as any as S.Schema<MigrateD1Output>;

export type QueuePauseOperation = "pause";
export const QueuePauseOperation = S.String;

export interface PauseQueueInput {
  /** Reserved-class cell scope derived by Celld, not a database, namespace or queue display name. */
  scope: string;
  /** Optional cell identity name; include the exact encoded query string in the peer signature. */
  name?: string;
  /** Peer protocol version; send the string 5. */
  peer_version: string;
  /** Source node name or operator identity, validated as a node name. */
  peer_source: string;
  /** Exact addressed node session identity, not the cell scope. */
  peer_target: string;
  /** Decimal Unix milliseconds as text; accepted within a 30000 ms clock window. */
  peer_timestamp: string;
  /** A fresh 16-byte nonce encoded as 32 hexadecimal characters; reuse is rejected. */
  peer_nonce: string;
  /** Lowercase SHA-256 hex digest of the exact serialized HTTP request body bytes. */
  peer_body_sha256: string;
  /** HMAC-SHA256 hex signature over newline-separated domain cells-peer-request-v1, version 5, method POST, exact path and query, body hash, source, target, timestamp and nonce, with no trailing newline. */
  peer_signature: string;
  op: QueuePauseOperation | (string & {});
}
export const PauseQueueInput = /*@__PURE__*/ S.suspend(() =>
  S.Struct({
    scope: S.String.pipe(T.Label(), T.LabelEncoding({ preserve: ":$" })),
    name: S.optional(S.String.pipe(T.Query())),
    peer_version: S.String.pipe(T.Header("x-cells-peer-version")),
    peer_source: S.String.pipe(T.Header("x-cells-peer-source")),
    peer_target: S.String.pipe(T.Header("x-cells-peer-target")),
    peer_timestamp: S.String.pipe(T.Header("x-cells-peer-timestamp")),
    peer_nonce: S.String.pipe(T.Header("x-cells-peer-nonce")),
    peer_body_sha256: S.String.pipe(T.Header("x-cells-peer-body-sha256")),
    peer_signature: S.String.pipe(T.Header("x-cells-peer-signature")),
    op: QueuePauseOperation,
  }).pipe(T.Http({ method: "POST", uri: "/runtime/{scope}", code: 200 })),
).annotate({
  identifier: "PauseQueueInput",
}) as any as S.Schema<PauseQueueInput>;

export interface QueuePausedResult {
  backlog_count: number;
  backlog_bytes: number;
  /** Unix milliseconds; null when no message exists. */
  oldest_message_timestamp?: number | null;
  paused: boolean;
}
export const QueuePausedResult = /*@__PURE__*/ S.suspend(() =>
  S.Struct({
    backlog_count: S.Number.pipe(T.Body("backlogCount")),
    backlog_bytes: S.Number.pipe(T.Body("backlogBytes")),
    oldest_message_timestamp: S.optional(S.NullOr(S.Number).pipe(T.Body("oldestMessageTimestamp"))),
    paused: S.Boolean,
  }),
).annotate({
  identifier: "QueuePausedResult",
}) as any as S.Schema<QueuePausedResult>;

/** The actual HTTP JSON envelope is {"result": ...}; nested arrays or scalars are not top-level raw responses. */
export interface PauseQueueOutput {
  result: QueuePausedResult;
}
export const PauseQueueOutput = /*@__PURE__*/ S.suspend(() =>
  S.Struct({
    result: QueuePausedResult,
  }),
).annotate({
  identifier: "PauseQueueOutput",
}) as any as S.Schema<PauseQueueOutput>;

export type PeekQueueOperation = "peek";
export const PeekQueueOperation = S.String;

export interface PeekQueueInput {
  /** Reserved-class cell scope derived by Celld, not a database, namespace or queue display name. */
  scope: string;
  /** Optional cell identity name; include the exact encoded query string in the peer signature. */
  name?: string;
  /** Peer protocol version; send the string 5. */
  peer_version: string;
  /** Source node name or operator identity, validated as a node name. */
  peer_source: string;
  /** Exact addressed node session identity, not the cell scope. */
  peer_target: string;
  /** Decimal Unix milliseconds as text; accepted within a 30000 ms clock window. */
  peer_timestamp: string;
  /** A fresh 16-byte nonce encoded as 32 hexadecimal characters; reuse is rejected. */
  peer_nonce: string;
  /** Lowercase SHA-256 hex digest of the exact serialized HTTP request body bytes. */
  peer_body_sha256: string;
  /** HMAC-SHA256 hex signature over newline-separated domain cells-peer-request-v1, version 5, method POST, exact path and query, body hash, source, target, timestamp and nonce, with no trailing newline. */
  peer_signature: string;
  op: PeekQueueOperation | (string & {});
  /** Defaults to 10; valid values are 1 through 100. */
  limit?: number;
}
export const PeekQueueInput = /*@__PURE__*/ S.suspend(() =>
  S.Struct({
    scope: S.String.pipe(T.Label(), T.LabelEncoding({ preserve: ":$" })),
    name: S.optional(S.String.pipe(T.Query())),
    peer_version: S.String.pipe(T.Header("x-cells-peer-version")),
    peer_source: S.String.pipe(T.Header("x-cells-peer-source")),
    peer_target: S.String.pipe(T.Header("x-cells-peer-target")),
    peer_timestamp: S.String.pipe(T.Header("x-cells-peer-timestamp")),
    peer_nonce: S.String.pipe(T.Header("x-cells-peer-nonce")),
    peer_body_sha256: S.String.pipe(T.Header("x-cells-peer-body-sha256")),
    peer_signature: S.String.pipe(T.Header("x-cells-peer-signature")),
    op: PeekQueueOperation,
    limit: S.optional(S.Number),
  }).pipe(T.Http({ method: "POST", uri: "/runtime/{scope}", code: 200 })),
).annotate({ identifier: "PeekQueueInput" }) as any as S.Schema<PeekQueueInput>;

export interface QueueMessage {
  id: string;
  body_base64: string;
  content_type: string;
  size: number;
  enqueued_at: number;
  visible_at: number;
  attempts: number;
  /** moving, purging, leased, visible or delayed. */
  state: string;
  /** Unix milliseconds; null unless actively leased. */
  leased_until?: number | null;
  /** May be null. */
  transfer_target?: string | null;
  /** May be null. */
  dead_letter_source?: string | null;
}
export const QueueMessage = /*@__PURE__*/ S.suspend(() =>
  S.Struct({
    id: S.String,
    body_base64: S.String.pipe(T.Body("bodyBase64")),
    content_type: S.String.pipe(T.Body("contentType")),
    size: S.Number,
    enqueued_at: S.Number.pipe(T.Body("enqueuedAt")),
    visible_at: S.Number.pipe(T.Body("visibleAt")),
    attempts: S.Number,
    state: S.String,
    leased_until: S.optional(S.NullOr(S.Number).pipe(T.Body("leasedUntil"))),
    transfer_target: S.optional(S.NullOr(S.String).pipe(T.Body("transferTarget"))),
    dead_letter_source: S.optional(S.NullOr(S.String).pipe(T.Body("deadLetterSource"))),
  }),
).annotate({ identifier: "QueueMessage" }) as any as S.Schema<QueueMessage>;

export type QueueMessages = Array<QueueMessage>;
export const QueueMessages = /*@__PURE__*/ S.Array(QueueMessage) as any as S.Schema<QueueMessages>;

export interface PeekQueueResult {
  messages: QueueMessages;
}
export const PeekQueueResult = /*@__PURE__*/ S.suspend(() =>
  S.Struct({
    messages: QueueMessages,
  }),
).annotate({
  identifier: "PeekQueueResult",
}) as any as S.Schema<PeekQueueResult>;

/** The actual HTTP JSON envelope is {"result": ...}; nested arrays or scalars are not top-level raw responses. */
export interface PeekQueueOutput {
  result: PeekQueueResult;
}
export const PeekQueueOutput = /*@__PURE__*/ S.suspend(() =>
  S.Struct({
    result: PeekQueueResult,
  }),
).annotate({
  identifier: "PeekQueueOutput",
}) as any as S.Schema<PeekQueueOutput>;

export type QueuePurgeOperation = "purge";
export const QueuePurgeOperation = S.String;

export interface PurgeQueueInput {
  /** Reserved-class cell scope derived by Celld, not a database, namespace or queue display name. */
  scope: string;
  /** Optional cell identity name; include the exact encoded query string in the peer signature. */
  name?: string;
  /** Peer protocol version; send the string 5. */
  peer_version: string;
  /** Source node name or operator identity, validated as a node name. */
  peer_source: string;
  /** Exact addressed node session identity, not the cell scope. */
  peer_target: string;
  /** Decimal Unix milliseconds as text; accepted within a 30000 ms clock window. */
  peer_timestamp: string;
  /** A fresh 16-byte nonce encoded as 32 hexadecimal characters; reuse is rejected. */
  peer_nonce: string;
  /** Lowercase SHA-256 hex digest of the exact serialized HTTP request body bytes. */
  peer_body_sha256: string;
  /** HMAC-SHA256 hex signature over newline-separated domain cells-peer-request-v1, version 5, method POST, exact path and query, body hash, source, target, timestamp and nonce, with no trailing newline. */
  peer_signature: string;
  op: QueuePurgeOperation | (string & {});
}
export const PurgeQueueInput = /*@__PURE__*/ S.suspend(() =>
  S.Struct({
    scope: S.String.pipe(T.Label(), T.LabelEncoding({ preserve: ":$" })),
    name: S.optional(S.String.pipe(T.Query())),
    peer_version: S.String.pipe(T.Header("x-cells-peer-version")),
    peer_source: S.String.pipe(T.Header("x-cells-peer-source")),
    peer_target: S.String.pipe(T.Header("x-cells-peer-target")),
    peer_timestamp: S.String.pipe(T.Header("x-cells-peer-timestamp")),
    peer_nonce: S.String.pipe(T.Header("x-cells-peer-nonce")),
    peer_body_sha256: S.String.pipe(T.Header("x-cells-peer-body-sha256")),
    peer_signature: S.String.pipe(T.Header("x-cells-peer-signature")),
    op: QueuePurgeOperation,
  }).pipe(T.Http({ method: "POST", uri: "/runtime/{scope}", code: 200 })),
).annotate({
  identifier: "PurgeQueueInput",
}) as any as S.Schema<PurgeQueueInput>;

export interface QueueMetrics {
  backlog_count: number;
  backlog_bytes: number;
  /** Unix milliseconds; null when no message exists. */
  oldest_message_timestamp?: number | null;
}
export const QueueMetrics = /*@__PURE__*/ S.suspend(() =>
  S.Struct({
    backlog_count: S.Number.pipe(T.Body("backlogCount")),
    backlog_bytes: S.Number.pipe(T.Body("backlogBytes")),
    oldest_message_timestamp: S.optional(S.NullOr(S.Number).pipe(T.Body("oldestMessageTimestamp"))),
  }),
).annotate({ identifier: "QueueMetrics" }) as any as S.Schema<QueueMetrics>;

export interface PurgeQueueResult {
  deleted: number;
  leased: number;
  metrics: QueueMetrics;
}
export const PurgeQueueResult = /*@__PURE__*/ S.suspend(() =>
  S.Struct({
    deleted: S.Number,
    leased: S.Number,
    metrics: QueueMetrics,
  }),
).annotate({
  identifier: "PurgeQueueResult",
}) as any as S.Schema<PurgeQueueResult>;

/** The actual HTTP JSON envelope is {"result": ...}; nested arrays or scalars are not top-level raw responses. */
export interface PurgeQueueOutput {
  result: PurgeQueueResult;
}
export const PurgeQueueOutput = /*@__PURE__*/ S.suspend(() =>
  S.Struct({
    result: PurgeQueueResult,
  }),
).annotate({
  identifier: "PurgeQueueOutput",
}) as any as S.Schema<PurgeQueueOutput>;

export type KvPutOperation = "put";
export const KvPutOperation = S.String;

export type Bytes = Array<number>;
export const Bytes = /*@__PURE__*/ S.Array(S.Number) as any as S.Schema<Bytes>;

export interface PutKvInput {
  /** Reserved-class cell scope derived by Celld, not a database, namespace or queue display name. */
  scope: string;
  /** Optional cell identity name; include the exact encoded query string in the peer signature. */
  name?: string;
  /** Peer protocol version; send the string 5. */
  peer_version: string;
  /** Source node name or operator identity, validated as a node name. */
  peer_source: string;
  /** Exact addressed node session identity, not the cell scope. */
  peer_target: string;
  /** Decimal Unix milliseconds as text; accepted within a 30000 ms clock window. */
  peer_timestamp: string;
  /** A fresh 16-byte nonce encoded as 32 hexadecimal characters; reuse is rejected. */
  peer_nonce: string;
  /** Lowercase SHA-256 hex digest of the exact serialized HTTP request body bytes. */
  peer_body_sha256: string;
  /** HMAC-SHA256 hex signature over newline-separated domain cells-peer-request-v1, version 5, method POST, exact path and query, body hash, source, target, timestamp and nonce, with no trailing newline. */
  peer_signature: string;
  op: KvPutOperation | (string & {});
  key: string;
  /** Defaults to bytes. */
  tag?: string;
  /** JSON-encoded metadata text, not an object. */
  metadata?: string;
  /** Absolute Unix expiration in seconds. */
  expiration?: number;
  /** Relative expiry in seconds. The wire key is expirationTtl, as used by the source handler. */
  expiration_ttl?: number;
  value: Bytes;
}
export const PutKvInput = /*@__PURE__*/ S.suspend(() =>
  S.Struct({
    scope: S.String.pipe(T.Label(), T.LabelEncoding({ preserve: ":$" })),
    name: S.optional(S.String.pipe(T.Query())),
    peer_version: S.String.pipe(T.Header("x-cells-peer-version")),
    peer_source: S.String.pipe(T.Header("x-cells-peer-source")),
    peer_target: S.String.pipe(T.Header("x-cells-peer-target")),
    peer_timestamp: S.String.pipe(T.Header("x-cells-peer-timestamp")),
    peer_nonce: S.String.pipe(T.Header("x-cells-peer-nonce")),
    peer_body_sha256: S.String.pipe(T.Header("x-cells-peer-body-sha256")),
    peer_signature: S.String.pipe(T.Header("x-cells-peer-signature")),
    op: KvPutOperation,
    key: S.String,
    tag: S.optional(S.String),
    metadata: S.optional(S.String),
    expiration: S.optional(S.Number),
    expiration_ttl: S.optional(S.Number.pipe(T.Body("expirationTtl"))),
    value: Bytes,
  }).pipe(T.Http({ method: "POST", uri: "/runtime/{scope}", code: 200 })),
).annotate({ identifier: "PutKvInput" }) as any as S.Schema<PutKvInput>;

/** The actual HTTP JSON envelope is {"result": ...}; nested arrays or scalars are not top-level raw responses. */
export interface PutKvOutput {
  result: OkResult;
}
export const PutKvOutput = /*@__PURE__*/ S.suspend(() =>
  S.Struct({
    result: OkResult,
  }),
).annotate({ identifier: "PutKvOutput" }) as any as S.Schema<PutKvOutput>;

export type PutKvBase64Operation = "put-base64";
export const PutKvBase64Operation = S.String;

export interface PutKvBase64Input {
  /** Reserved-class cell scope derived by Celld, not a database, namespace or queue display name. */
  scope: string;
  /** Optional cell identity name; include the exact encoded query string in the peer signature. */
  name?: string;
  /** Peer protocol version; send the string 5. */
  peer_version: string;
  /** Source node name or operator identity, validated as a node name. */
  peer_source: string;
  /** Exact addressed node session identity, not the cell scope. */
  peer_target: string;
  /** Decimal Unix milliseconds as text; accepted within a 30000 ms clock window. */
  peer_timestamp: string;
  /** A fresh 16-byte nonce encoded as 32 hexadecimal characters; reuse is rejected. */
  peer_nonce: string;
  /** Lowercase SHA-256 hex digest of the exact serialized HTTP request body bytes. */
  peer_body_sha256: string;
  /** HMAC-SHA256 hex signature over newline-separated domain cells-peer-request-v1, version 5, method POST, exact path and query, body hash, source, target, timestamp and nonce, with no trailing newline. */
  peer_signature: string;
  op: PutKvBase64Operation | (string & {});
  key: string;
  /** Defaults to bytes. */
  tag?: string;
  /** JSON-encoded metadata text, not an object. */
  metadata?: string;
  /** Absolute Unix expiration in seconds. */
  expiration?: number;
  /** Relative expiry in seconds. The wire key is expirationTtl, as used by the source handler. */
  expiration_ttl?: number;
  value: string;
}
export const PutKvBase64Input = /*@__PURE__*/ S.suspend(() =>
  S.Struct({
    scope: S.String.pipe(T.Label(), T.LabelEncoding({ preserve: ":$" })),
    name: S.optional(S.String.pipe(T.Query())),
    peer_version: S.String.pipe(T.Header("x-cells-peer-version")),
    peer_source: S.String.pipe(T.Header("x-cells-peer-source")),
    peer_target: S.String.pipe(T.Header("x-cells-peer-target")),
    peer_timestamp: S.String.pipe(T.Header("x-cells-peer-timestamp")),
    peer_nonce: S.String.pipe(T.Header("x-cells-peer-nonce")),
    peer_body_sha256: S.String.pipe(T.Header("x-cells-peer-body-sha256")),
    peer_signature: S.String.pipe(T.Header("x-cells-peer-signature")),
    op: PutKvBase64Operation,
    key: S.String,
    tag: S.optional(S.String),
    metadata: S.optional(S.String),
    expiration: S.optional(S.Number),
    expiration_ttl: S.optional(S.Number.pipe(T.Body("expirationTtl"))),
    value: S.String,
  }).pipe(T.Http({ method: "POST", uri: "/runtime/{scope}", code: 200 })),
).annotate({
  identifier: "PutKvBase64Input",
}) as any as S.Schema<PutKvBase64Input>;

/** The actual HTTP JSON envelope is {"result": ...}; nested arrays or scalars are not top-level raw responses. */
export interface PutKvBase64Output {
  result: OkResult;
}
export const PutKvBase64Output = /*@__PURE__*/ S.suspend(() =>
  S.Struct({
    result: OkResult,
  }),
).annotate({
  identifier: "PutKvBase64Output",
}) as any as S.Schema<PutKvBase64Output>;

export type RedriveQueueOperation = "redrive";
export const RedriveQueueOperation = S.String;

export interface RedriveQueueInput {
  /** Reserved-class cell scope derived by Celld, not a database, namespace or queue display name. */
  scope: string;
  /** Optional cell identity name; include the exact encoded query string in the peer signature. */
  name?: string;
  /** Peer protocol version; send the string 5. */
  peer_version: string;
  /** Source node name or operator identity, validated as a node name. */
  peer_source: string;
  /** Exact addressed node session identity, not the cell scope. */
  peer_target: string;
  /** Decimal Unix milliseconds as text; accepted within a 30000 ms clock window. */
  peer_timestamp: string;
  /** A fresh 16-byte nonce encoded as 32 hexadecimal characters; reuse is rejected. */
  peer_nonce: string;
  /** Lowercase SHA-256 hex digest of the exact serialized HTTP request body bytes. */
  peer_body_sha256: string;
  /** HMAC-SHA256 hex signature over newline-separated domain cells-peer-request-v1, version 5, method POST, exact path and query, body hash, source, target, timestamp and nonce, with no trailing newline. */
  peer_signature: string;
  op: RedriveQueueOperation | (string & {});
  /** Defaults to 100; valid values are 1 through 100. */
  limit?: number;
}
export const RedriveQueueInput = /*@__PURE__*/ S.suspend(() =>
  S.Struct({
    scope: S.String.pipe(T.Label(), T.LabelEncoding({ preserve: ":$" })),
    name: S.optional(S.String.pipe(T.Query())),
    peer_version: S.String.pipe(T.Header("x-cells-peer-version")),
    peer_source: S.String.pipe(T.Header("x-cells-peer-source")),
    peer_target: S.String.pipe(T.Header("x-cells-peer-target")),
    peer_timestamp: S.String.pipe(T.Header("x-cells-peer-timestamp")),
    peer_nonce: S.String.pipe(T.Header("x-cells-peer-nonce")),
    peer_body_sha256: S.String.pipe(T.Header("x-cells-peer-body-sha256")),
    peer_signature: S.String.pipe(T.Header("x-cells-peer-signature")),
    op: RedriveQueueOperation,
    limit: S.optional(S.Number),
  }).pipe(T.Http({ method: "POST", uri: "/runtime/{scope}", code: 200 })),
).annotate({
  identifier: "RedriveQueueInput",
}) as any as S.Schema<RedriveQueueInput>;

export interface RedriveQueueResult {
  redriven: number;
  metrics: QueueMetrics;
}
export const RedriveQueueResult = /*@__PURE__*/ S.suspend(() =>
  S.Struct({
    redriven: S.Number,
    metrics: QueueMetrics,
  }),
).annotate({
  identifier: "RedriveQueueResult",
}) as any as S.Schema<RedriveQueueResult>;

/** The actual HTTP JSON envelope is {"result": ...}; nested arrays or scalars are not top-level raw responses. */
export interface RedriveQueueOutput {
  result: RedriveQueueResult;
}
export const RedriveQueueOutput = /*@__PURE__*/ S.suspend(() =>
  S.Struct({
    result: RedriveQueueResult,
  }),
).annotate({
  identifier: "RedriveQueueOutput",
}) as any as S.Schema<RedriveQueueOutput>;

export type QueueResumeOperation = "resume";
export const QueueResumeOperation = S.String;

export interface ResumeQueueInput {
  /** Reserved-class cell scope derived by Celld, not a database, namespace or queue display name. */
  scope: string;
  /** Optional cell identity name; include the exact encoded query string in the peer signature. */
  name?: string;
  /** Peer protocol version; send the string 5. */
  peer_version: string;
  /** Source node name or operator identity, validated as a node name. */
  peer_source: string;
  /** Exact addressed node session identity, not the cell scope. */
  peer_target: string;
  /** Decimal Unix milliseconds as text; accepted within a 30000 ms clock window. */
  peer_timestamp: string;
  /** A fresh 16-byte nonce encoded as 32 hexadecimal characters; reuse is rejected. */
  peer_nonce: string;
  /** Lowercase SHA-256 hex digest of the exact serialized HTTP request body bytes. */
  peer_body_sha256: string;
  /** HMAC-SHA256 hex signature over newline-separated domain cells-peer-request-v1, version 5, method POST, exact path and query, body hash, source, target, timestamp and nonce, with no trailing newline. */
  peer_signature: string;
  op: QueueResumeOperation | (string & {});
}
export const ResumeQueueInput = /*@__PURE__*/ S.suspend(() =>
  S.Struct({
    scope: S.String.pipe(T.Label(), T.LabelEncoding({ preserve: ":$" })),
    name: S.optional(S.String.pipe(T.Query())),
    peer_version: S.String.pipe(T.Header("x-cells-peer-version")),
    peer_source: S.String.pipe(T.Header("x-cells-peer-source")),
    peer_target: S.String.pipe(T.Header("x-cells-peer-target")),
    peer_timestamp: S.String.pipe(T.Header("x-cells-peer-timestamp")),
    peer_nonce: S.String.pipe(T.Header("x-cells-peer-nonce")),
    peer_body_sha256: S.String.pipe(T.Header("x-cells-peer-body-sha256")),
    peer_signature: S.String.pipe(T.Header("x-cells-peer-signature")),
    op: QueueResumeOperation,
  }).pipe(T.Http({ method: "POST", uri: "/runtime/{scope}", code: 200 })),
).annotate({
  identifier: "ResumeQueueInput",
}) as any as S.Schema<ResumeQueueInput>;

/** The actual HTTP JSON envelope is {"result": ...}; nested arrays or scalars are not top-level raw responses. */
export interface ResumeQueueOutput {
  result: QueuePausedResult;
}
export const ResumeQueueOutput = /*@__PURE__*/ S.suspend(() =>
  S.Struct({
    result: QueuePausedResult,
  }),
).annotate({
  identifier: "ResumeQueueOutput",
}) as any as S.Schema<ResumeQueueOutput>;
