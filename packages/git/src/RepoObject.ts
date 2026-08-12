/**
 * The per-repo Durable Object (DESIGN.md §2, §3.4, §3.6, §8).
 *
 * One DO per repo, addressed by `getByName(repoId)` (a ULID — never
 * `owner/name`, so renames never move data). The DO owns refs, the object
 * index and loose bytes, tokens, the commit graph, push staging, and the
 * alarm jobs (import / fork / delete-purge / staging-GC). It runs the git
 * v0 wire protocol in its `fetch` handler — advertisement, upload-pack,
 * receive-pack — because every byte those need lives in this DO's SQLite.
 *
 * NOTE: the protocol *choreography* (advertisement builder, request
 * parsers, pack writer/parser) is implemented in this file against the
 * pure codec primitives in `src/git/` (`Pkt`, `Sideband`, `ObjectCodec`,
 * `Delta`, `Zlib`, `Store`). DESIGN.md places these in
 * `src/git/{Advertise,UploadPack,ReceivePack,PackParser,PackWriter}.ts`;
 * they live here (exported) until the git-layer split lands — moving them
 * is a mechanical extraction.
 *
 * @section Wire endpoints
 * The Worker proxies these untouched to `stub.fetch`:
 * @example Routes served by this DO's fetch handler
 * ```
 * GET  /:owner/:repo[.git]/info/refs?service=git-(upload|receive)-pack
 * POST /:owner/:repo[.git]/git-upload-pack
 * POST /:owner/:repo[.git]/git-receive-pack
 * ```
 */
import * as Cloudflare from "alchemy/Cloudflare";
import type { HttpEffect } from "alchemy/Http";
import { RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import {
  Forbidden,
  ObjectNotFound,
  ReadOnlyRepo,
  RefConflict,
  RefNotFound,
  RepoNotFound,
  TokenNotFound,
  Unauthorized,
  WrongObjectType,
  type Oid as ApiOid,
  type RepoStatus,
  type TokenScope,
} from "./Api.ts";
import { hashToken, mintToken, parseBasicOrBearer } from "./Auth.ts";
import { applyDelta } from "./git/Delta.ts";
import * as PackParser from "./git/PackParser.ts";
import { bufferRandomAccess, type RandomAccess } from "./git/PackParser.ts";
import {
  bytesToHex,
  concatBytes,
  decodeOfsDeltaOffset,
  decodeTypeSize,
  encodeTypeSize,
  hashObject,
  isDeltaType,
  isOid,
  makeSha1,
  ObjectType,
  objectTypeName,
  parseCommit,
  parseTag,
  parseTree,
  treeEntryKind,
  utf8Encode,
  ZERO_OID,
  type ObjectTypeName,
  type Oid,
} from "./git/ObjectCodec.ts";
import {
  decodePktLines,
  errPkt,
  flushPkt,
  pktPayloadText,
  pktText,
  readPktLineAt,
  type PktLine,
} from "./git/Pkt.ts";
import {
  progressMessage,
  sidebandFrames,
  wrapSideband,
} from "./git/Sideband.ts";
import {
  StoreError,
  type ManifestEntry,
  type ObjectSource,
} from "./git/Store.ts";
import * as Zlib from "./git/Zlib.ts";
import { runImport, type ImportSource } from "./jobs/Import.ts";
import { runForkJob, snapshotStream, type SnapshotChunk } from "./jobs/Fork.ts";
import { bundleCovers, runBundleJob, type BundleInfo } from "./jobs/Bundle.ts";
import { runCompactJob, shouldCompact } from "./jobs/Compact.ts";
import { incomingKey } from "./store/Keys.ts";
import { r2RandomAccess } from "./store/PackSource.ts";
import { runPurgeJob } from "./jobs/Purge.ts";
import { Registry, REGISTRY_DO_NAME, ulid } from "./RegistryObject.ts";
import { computeClosure } from "./store/Closure.ts";
import {
  makeObjectStore,
  MAX_OBJECT_SIZE,
  type ObjectStore,
  type StagedObject,
} from "./store/ObjectStore.ts";
import {
  initRepoSchema,
  makeSqlClient,
  type JobRow,
  type RefRow,
  type TokenRow,
} from "./store/Sql.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pushes up to this size are ingested straight from memory; larger ones are
 * parked in R2 and parsed from there (DESIGN.md §3.6). A **buffering
 * threshold, not a limit** — a push larger than this is no longer rejected.
 *
 * 50 MiB is the memory-safe ceiling for the in-memory path (pack + delta
 * bases inside a 128 MB isolate) and is the measured-fast path: the
 * 38 MiB alchemy-repo push ingests in ~20 s here.
 *
 * MEASURED CAVEAT: the R2-backed path above this threshold is correct but
 * currently **much** slower — `PackParser` issues a read per entry, and an
 * entry-sized read against window-cached R2 costs a stitch/copy each time,
 * so a 13.7k-object pack takes minutes rather than seconds. Making large
 * pushes fast needs the parser to consume a *sequential cursor* (one
 * forward-only stream with a small pushback buffer) instead of random
 * reads; the seam is `RandomAccess`, so that change stays local to
 * `PackParser` + `store/PackSource.ts`.
 */
export const MAX_PACK_BYTES = 50 * 1024 * 1024;

/** Agent string advertised on the wire. */
export const GIT_AGENT = "git-service/1";

/** How long a second push waits for the ingest semaphore before 503. */
export const PUSH_WAIT_TIMEOUT = "30 seconds";

/** How long crashed push staging survives before the GC alarm reaps it. */
export const STAGING_TTL_MS = 24 * 60 * 60 * 1000;

/** The realm sent on wire 401s. */
export const WWW_AUTHENTICATE = 'Basic realm="git-service"' as const;

/**
 * Worker↔DO headers for the clone-bundle splice (DESIGN.md §11): the DO
 * answers an eligible clone with these *instead of* the pack, and the
 * Worker streams the named R2 object to the client. Only
 * {@link BUNDLE_HASH_HEADER} is kept on the client-visible response, as
 * observable proof the fast path served the clone.
 */
export const BUNDLE_KEY_HEADER = "x-git-bundle-key" as const;
export const BUNDLE_HASH_HEADER = "x-git-bundle" as const;
export const BUNDLE_COUNT_HEADER = "x-git-bundle-count" as const;
export const BUNDLE_SIDEBAND_HEADER = "x-git-bundle-sideband" as const;

/**
 * Internal header the Worker sets (after verifying the deployer admin key
 * and stripping any inbound copy) so the DO can honor admin-key wire
 * access. Never trusted from outside — only the Worker can reach the DO.
 */
export const ADMIN_HEADER = "x-git-service-admin" as const;

// ─────────────────────────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A push pack failed to ingest (malformed, oversize, checksum mismatch,
 * missing thin base, delta error). Reported in-band as `unpack <reason>` +
 * per-ref `ng` — never as an HTTP error.
 */
export class PackIngestError extends Schema.TaggedError<PackIngestError>()(
  "PackIngestError",
  { reason: Schema.String },
) {}

/**
 * A syntactically valid request that the v0 grammar does not allow
 * (missing wants, malformed command lines, unsupported deepen flavors).
 * Answered with an `ERR` pkt.
 */
export class WireProtocolError extends Schema.TaggedError<WireProtocolError>()(
  "WireProtocolError",
  { reason: Schema.String },
) {}

// ─────────────────────────────────────────────────────────────────────────────
// RPC data shapes (plain serializable data — no Schema classes over RPC)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Who is calling: the deployer admin key (verified by the Worker) or a
 * per-repo token (verified here, in the DO that owns the tokens table).
 */
export type CallerAuth =
  | { readonly kind: "admin" }
  | { readonly kind: "token"; readonly token: string };

/** Repo metadata as stored in the `config` table. */
export interface RepoMetaData {
  readonly repoId: string;
  readonly owner: string;
  readonly name: string;
  readonly defaultBranch: string;
  readonly description: string | null;
  readonly readOnly: boolean;
  readonly forkOf: string | null;
  readonly status: RepoStatus;
  readonly createdAt: number;
  /** Object storage breakdown (DESIGN.md §12.1). */
  readonly objects: ObjectStatsData;
}

/** Where a repo's objects live — see the REST `ObjectStats` schema. */
export interface ObjectStatsData {
  readonly loose: number;
  readonly packed: number;
  readonly r2: number;
  readonly bytes: number;
}

/** Patch accepted by {@link GitRepoShape.updateRepoMeta}. */
export interface RepoMetaPatch {
  readonly description?: string | null | undefined;
  /** Must resolve to an existing branch. */
  readonly defaultBranch?: string | undefined;
  readonly readOnly?: boolean | undefined;
}

/** One ref (peeled target present for annotated tags). */
export interface RefData {
  readonly name: string;
  readonly oid: string;
  readonly peeled?: string | undefined;
}

/** Result of {@link GitRepoShape.listRefs}. */
export interface RefsPage {
  /** The default branch's full ref name, `null` on an unborn repo. */
  readonly head: string | null;
  readonly refs: ReadonlyArray<RefData>;
}

/** Token metadata (never the secret). */
export interface TokenData {
  readonly id: string;
  readonly name: string;
  readonly scope: TokenScope;
  readonly createdAt: number;
  readonly expiresAt: number | null;
  readonly lastUsedAt: number | null;
}

/** A freshly minted token: metadata + the secret, shown exactly once. */
export interface CreatedTokenData extends TokenData {
  readonly token: string;
}

/** Input of {@link GitRepoShape.initRepo} (also fork/import bootstrap). */
export interface InitRepoInput {
  readonly repoId: string;
  readonly owner: string;
  readonly name: string;
  readonly defaultBranch: string;
  readonly description: string | null;
  readonly readOnly: boolean;
  readonly forkOf: string | null;
}

/** Result of init/fork/import bootstrap: the meta + a bootstrap token. */
export interface InitRepoResult {
  readonly meta: RepoMetaData;
  /** Bootstrap `write` token (DESIGN.md §5 `RepoCreated`). */
  readonly token: CreatedTokenData;
}

/** Input of {@link GitRepoShape.updateRef}. */
export interface UpdateRefInput {
  readonly name: string;
  readonly newOid: string;
  /**
   * CAS token: `string` = must currently equal; `null` = must not exist;
   * absent = unconditional.
   */
  readonly expectedOid?: string | null | undefined;
}

/** Input of {@link GitRepoShape.removeRef}. */
export interface RemoveRefInput {
  readonly name: string;
  readonly expectedOid?: string | undefined;
}

/** Input of {@link GitRepoShape.readObject}. */
export interface ReadObjectInput {
  readonly oid: string;
  /** When set, a different actual type fails with `WrongObjectType`. */
  readonly expect?: ObjectTypeName | undefined;
}

/** A fully-read object (content inflated, ≤ 64 MiB by the ingest cap). */
export interface ObjectData {
  readonly oid: string;
  readonly type: ObjectTypeName;
  readonly size: number;
  readonly content: Uint8Array;
}

/** One commit for the REST read surface. */
export interface CommitData {
  readonly oid: string;
  readonly tree: string;
  readonly parents: ReadonlyArray<string>;
  readonly author: SignatureData;
  readonly committer: SignatureData;
  readonly message: string;
}

/** An author/committer signature. */
export interface SignatureData {
  readonly name: string;
  readonly email: string;
  readonly date: number;
  readonly tz: string;
}

/** Input of {@link GitRepoShape.readCommitLog}. */
export interface CommitLogInput {
  /** Refname or 40-hex oid; default = HEAD (the default branch). */
  readonly ref?: string | undefined;
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

/** One page of {@link GitRepoShape.readCommitLog}. */
export interface CommitLogPage {
  readonly items: ReadonlyArray<CommitData>;
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

/** Input of {@link GitRepoShape.readFileAtPath}. */
export interface ReadFileInput {
  /** Refname or 40-hex oid; default = HEAD. */
  readonly ref?: string | undefined;
  /** Slash-separated path inside the tree. */
  readonly path: string;
}

/** A file read via tree walk. */
export interface FileData {
  readonly oid: string;
  /** Octal mode string, e.g. `100644`. */
  readonly mode: string;
  readonly size: number;
  readonly content: Uint8Array;
}

/** Input of {@link GitRepoShape.startImport}. */
export interface StartImportInput extends InitRepoInput {
  readonly source: ImportSource;
}

/** Input of {@link GitRepoShape.startFork}. */
export interface StartForkInput extends InitRepoInput {
  readonly parentRepoId: string;
}

/** The common auth+repo error union of most RPC methods. */
export type RepoAuthError =
  | Unauthorized
  | Forbidden
  | RepoNotFound
  | StoreError;

/**
 * The Repo DO's typed RPC surface. All methods are `RuntimeContext`-colored
 * (callable only through a stub / inside the deployed Worker). Note: no
 * method may be named `delete` (Cloudflare stub proxy reserves it).
 */
export interface GitRepoShape {
  /** Seeds config + mints the bootstrap `write` token (repo create). */
  readonly initRepo: (
    input: InitRepoInput,
  ) => Effect.Effect<InitRepoResult, StoreError, RuntimeContext>;
  /** Seeds config with `status: importing`, arms the import alarm job. */
  readonly startImport: (
    input: StartImportInput,
  ) => Effect.Effect<InitRepoResult, StoreError, RuntimeContext>;
  /** Seeds config with `status: forking`, arms the fork alarm job. */
  readonly startFork: (
    input: StartForkInput,
  ) => Effect.Effect<InitRepoResult, StoreError, RuntimeContext>;
  /** Flips `status: deleting` and arms the purge alarm job. */
  /**
   * Arms a compaction run now (admin): loose object bytes are moved into an
   * immutable R2 pack by the alarm (DESIGN.md §12.1). Normally armed
   * automatically by the post-push size check.
   */
  readonly startCompact: (
    auth: CallerAuth,
  ) => Effect.Effect<void, RepoAuthError, RuntimeContext>;
  readonly startPurge: (
    auth: CallerAuth,
  ) => Effect.Effect<void, RepoAuthError, RuntimeContext>;
  /**
   * Verifies a token by its sha-256 hex hash against the `tokens` table:
   * unknown/expired ⇒ `Unauthorized`; insufficient scope ⇒ `Forbidden`.
   * Bumps `last_used_at` at hourly granularity.
   */
  readonly verifyToken: (
    tokenHash: string,
    required: TokenScope,
  ) => Effect.Effect<
    TokenData,
    Unauthorized | Forbidden | StoreError,
    RuntimeContext
  >;
  readonly getRepoMeta: (
    auth: CallerAuth,
  ) => Effect.Effect<RepoMetaData, RepoAuthError, RuntimeContext>;
  readonly updateRepoMeta: (
    auth: CallerAuth,
    patch: RepoMetaPatch,
  ) => Effect.Effect<RepoMetaData, RepoAuthError | RefNotFound, RuntimeContext>;
  readonly createToken: (
    auth: CallerAuth,
    input: {
      readonly name: string;
      readonly scope: TokenScope;
      readonly ttlSeconds?: number | undefined;
    },
  ) => Effect.Effect<CreatedTokenData, RepoAuthError, RuntimeContext>;
  readonly listTokens: (
    auth: CallerAuth,
  ) => Effect.Effect<ReadonlyArray<TokenData>, RepoAuthError, RuntimeContext>;
  readonly revokeToken: (
    auth: CallerAuth,
    id: string,
  ) => Effect.Effect<void, RepoAuthError | TokenNotFound, RuntimeContext>;
  readonly listRefs: (
    auth: CallerAuth,
    prefix?: string | undefined,
  ) => Effect.Effect<RefsPage, RepoAuthError, RuntimeContext>;
  readonly getRef: (
    auth: CallerAuth,
    name: string,
  ) => Effect.Effect<RefData, RepoAuthError | RefNotFound, RuntimeContext>;
  readonly updateRef: (
    auth: CallerAuth,
    input: UpdateRefInput,
  ) => Effect.Effect<
    RefData,
    RepoAuthError | RefConflict | ObjectNotFound | ReadOnlyRepo,
    RuntimeContext
  >;
  readonly removeRef: (
    auth: CallerAuth,
    input: RemoveRefInput,
  ) => Effect.Effect<
    void,
    RepoAuthError | RefNotFound | RefConflict | ReadOnlyRepo,
    RuntimeContext
  >;
  readonly readObject: (
    auth: CallerAuth,
    input: ReadObjectInput,
  ) => Effect.Effect<
    ObjectData,
    RepoAuthError | ObjectNotFound | WrongObjectType,
    RuntimeContext
  >;
  readonly readCommitLog: (
    auth: CallerAuth,
    input: CommitLogInput,
  ) => Effect.Effect<
    CommitLogPage,
    RepoAuthError | RefNotFound,
    RuntimeContext
  >;
  readonly readFileAtPath: (
    auth: CallerAuth,
    input: ReadFileInput,
  ) => Effect.Effect<
    FileData,
    RepoAuthError | RefNotFound | ObjectNotFound,
    RuntimeContext
  >;
  /**
   * Streams a row snapshot for a fork (DESIGN.md §2.3 Fork). Internal —
   * called only by a sibling Repo DO's fork alarm job; never routed from
   * the Worker.
   */
  readonly snapshotRows: () => Stream.Stream<SnapshotChunk, StoreError>;
  /** The git wire protocol (info/refs, upload-pack, receive-pack). */
  readonly fetch: HttpEffect<Cloudflare.DurableObjectState | RuntimeContext>;
  /** Alarm job dispatcher (import / fork / purge / gc). */
  readonly alarm: (
    info?: Cloudflare.AlarmInvocationInfo,
  ) => Effect.Effect<void, never, RuntimeContext>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Protocol choreography — pure helpers (exported for tests / future split)
// ─────────────────────────────────────────────────────────────────────────────

/** Upload-pack capability list (DESIGN.md §4). */
export const uploadCapabilities = (defaultBranch: string): string =>
  `multi_ack_detailed no-done side-band-64k shallow ofs-delta agent=${GIT_AGENT} symref=HEAD:refs/heads/${defaultBranch} object-format=sha1`;

/** Receive-pack capability list (DESIGN.md §4). */
export const receiveCapabilities = (): string =>
  `report-status report-status-v2 delete-refs side-band-64k atomic ofs-delta object-format=sha1 agent=${GIT_AGENT}`;

/** The two smart-HTTP services. */
export type GitService = "git-upload-pack" | "git-receive-pack";

/**
 * Builds the v0 `info/refs` advertisement (with `# service=` prelude):
 * HEAD first with the capability line, refs sorted, annotated tags peeled
 * (`^{}` lines), zero-id `capabilities^{}` on an empty repo.
 */
export const buildAdvertisement = (options: {
  readonly service: GitService;
  readonly defaultBranch: string;
  /** Sorted by name; peeled targets included for annotated tags. */
  readonly refs: ReadonlyArray<RefData>;
}): Uint8Array => {
  const caps =
    options.service === "git-upload-pack"
      ? uploadCapabilities(options.defaultBranch)
      : receiveCapabilities();
  const parts: Array<Uint8Array> = [
    pktText(`# service=${options.service}`),
    flushPkt,
  ];
  const lines: Array<string> = [];
  const headRef = options.refs.find(
    (ref) => ref.name === `refs/heads/${options.defaultBranch}`,
  );
  if (options.service === "git-upload-pack" && headRef !== undefined) {
    lines.push(`${headRef.oid} HEAD`);
  }
  for (const ref of options.refs) {
    lines.push(`${ref.oid} ${ref.name}`);
    if (ref.peeled !== undefined) {
      lines.push(`${ref.peeled} ${ref.name}^{}`);
    }
  }
  if (lines.length === 0) {
    parts.push(pktText(`${ZERO_OID} capabilities^{}\0${caps}`));
  } else {
    lines.forEach((line, index) => {
      parts.push(index === 0 ? pktText(`${line}\0${caps}`) : pktText(line));
    });
  }
  parts.push(flushPkt);
  return concatBytes(parts);
};

/** A parsed v0 upload-pack request. */
export interface UploadPackRequest {
  readonly wants: ReadonlyArray<Oid>;
  readonly haves: ReadonlyArray<Oid>;
  readonly done: boolean;
  readonly depth: number | undefined;
  readonly clientShallow: ReadonlyArray<Oid>;
  readonly capabilities: ReadonlySet<string>;
}

/**
 * Parses a v0 upload-pack POST body (already gunzipped) into wants /
 * shallow / deepen / haves / done. Rejects `deepen-since` / `deepen-not` /
 * `filter` (not advertised) with {@link WireProtocolError}.
 */
export const parseUploadPackRequest = (
  pkts: ReadonlyArray<PktLine>,
): Effect.Effect<UploadPackRequest, WireProtocolError> =>
  Effect.suspend(() => {
    const wants: Array<Oid> = [];
    const haves: Array<Oid> = [];
    const clientShallow: Array<Oid> = [];
    let done = false;
    let depth: number | undefined;
    let capabilities: ReadonlySet<string> = new Set();

    for (const pkt of pkts) {
      if (pkt._tag !== "data") continue;
      const text = pktPayloadText(pkt.payload);
      if (text === "done") {
        done = true;
        continue;
      }
      if (text.startsWith("want ")) {
        let rest = text.slice(5);
        if (wants.length === 0) {
          const space = rest.indexOf(" ");
          if (space !== -1) {
            capabilities = new Set(
              rest
                .slice(space + 1)
                .split(" ")
                .filter(Boolean),
            );
            rest = rest.slice(0, space);
          }
        }
        if (!isOid(rest)) {
          return Effect.fail(
            new WireProtocolError({ reason: `malformed want line: ${text}` }),
          );
        }
        wants.push(rest);
        continue;
      }
      if (text.startsWith("have ")) {
        const oid = text.slice(5, 45);
        if (isOid(oid)) haves.push(oid);
        continue;
      }
      if (text.startsWith("shallow ")) {
        const oid = text.slice(8);
        if (!isOid(oid)) {
          return Effect.fail(
            new WireProtocolError({
              reason: `malformed shallow line: ${text}`,
            }),
          );
        }
        clientShallow.push(oid);
        continue;
      }
      if (text.startsWith("deepen ")) {
        const n = Number.parseInt(text.slice(7), 10);
        if (!Number.isInteger(n) || n <= 0) {
          return Effect.fail(
            new WireProtocolError({ reason: `malformed deepen line: ${text}` }),
          );
        }
        depth = n;
        continue;
      }
      if (text.startsWith("deepen-since ") || text.startsWith("deepen-not ")) {
        return Effect.fail(
          new WireProtocolError({
            reason: `${text.split(" ")[0]} is not supported`,
          }),
        );
      }
      if (text.startsWith("filter ")) {
        return Effect.fail(
          new WireProtocolError({ reason: "filter is not supported" }),
        );
      }
      // ignore unknown lines defensively
    }
    if (wants.length === 0) {
      return Effect.fail(
        new WireProtocolError({ reason: "upload-pack request has no wants" }),
      );
    }
    return Effect.succeed({
      wants,
      haves,
      done,
      depth,
      clientShallow,
      capabilities,
    });
  });

/** One receive-pack command (`<old> <new> <refname>`). */
export interface RefCommand {
  readonly oldOid: Oid;
  readonly newOid: Oid;
  readonly ref: string;
}

/** A parsed v0 receive-pack request head. */
export interface ReceivePackRequest {
  readonly commands: ReadonlyArray<RefCommand>;
  readonly capabilities: ReadonlySet<string>;
  /** Byte offset of the pack within the body (== length when no pack). */
  readonly packStart: number;
  /** True for git's bare-flush `http.postBuffer` probe. */
  readonly probe: boolean;
}

const REF_NAME_REGEX = /^refs\/[^\s~^:?*\[\\]+$/;

/**
 * Parses a v0 receive-pack POST body (already gunzipped): command
 * pkt-lines (first carries `\0caps`) up to the flush, leaving the raw pack
 * bytes at `packStart`. Detects the empty-flush probe (DESIGN.md §2.3
 * Push step 2).
 */
export const parseReceivePackRequest = (
  body: Uint8Array,
): Effect.Effect<ReceivePackRequest, WireProtocolError> =>
  Effect.suspend(() => {
    const commands: Array<RefCommand> = [];
    let capabilities: ReadonlySet<string> = new Set();
    let pos = 0;
    let first = true;

    for (;;) {
      if (pos >= body.length) {
        // Body ended without a flush: only legal as the bare probe of an
        // entirely empty body.
        if (commands.length === 0 && pos === 0) {
          return Effect.succeed({
            commands: [],
            capabilities,
            packStart: body.length,
            probe: true,
          });
        }
        return Effect.fail(
          new WireProtocolError({
            reason: "receive-pack request ended before flush",
          }),
        );
      }
      const r = readPktLineAt(body, pos);
      if (r._tag === "incomplete" || r._tag === "invalid") {
        return Effect.fail(
          new WireProtocolError({
            reason:
              r._tag === "invalid"
                ? r.reason
                : "truncated receive-pack request",
          }),
        );
      }
      pos = r.next;
      if (r.pkt._tag === "flush") {
        return Effect.succeed({
          commands,
          capabilities,
          packStart: pos,
          probe: commands.length === 0 && pos >= body.length,
        });
      }
      if (r.pkt._tag !== "data") continue;
      let text = pktPayloadText(r.pkt.payload);
      if (first) {
        const nul = text.indexOf("\0");
        if (nul !== -1) {
          capabilities = new Set(
            text
              .slice(nul + 1)
              .split(" ")
              .filter(Boolean),
          );
          text = text.slice(0, nul);
        }
        first = false;
      }
      const oldOid = text.slice(0, 40);
      const newOid = text.slice(41, 81);
      const ref = text.slice(82);
      if (
        !isOid(oldOid) ||
        !isOid(newOid) ||
        text[40] !== " " ||
        text[81] !== " " ||
        !REF_NAME_REGEX.test(ref)
      ) {
        return Effect.fail(
          new WireProtocolError({ reason: `malformed command line: ${text}` }),
        );
      }
      commands.push({ oldOid, newOid, ref });
    }
  });

/** The 12-byte pack header: `PACK`, version 2, entry count. */
export const packHeader = (count: number): Uint8Array => {
  const out = new Uint8Array(12);
  out.set(utf8Encode("PACK"), 0);
  const view = new DataView(out.buffer);
  view.setUint32(4, 2);
  view.setUint32(8, count);
  return out;
};

/**
 * The §3.5 no-delta pack emitter: header + per-entry
 * `varint(type,size) + stored zdata` (verbatim — zero compression CPU) +
 * incremental SHA-1 trailer. Constant memory; the manifest is already
 * materialized so the count is known upfront.
 */
export const packStream = (
  entries: ReadonlyArray<ManifestEntry>,
  objects: ObjectSource,
): Stream.Stream<Uint8Array, StoreError> =>
  Stream.suspend(() => {
    const sha = makeSha1();
    const tap = (bytes: Uint8Array): Uint8Array => {
      sha.update(bytes);
      return bytes;
    };
    const header = Stream.sync(() => tap(packHeader(entries.length)));
    const body = Stream.fromIterable(entries).pipe(
      Stream.flatMap((entry) =>
        Stream.sync(() => tap(encodeTypeSize(entry.type, entry.size))).pipe(
          Stream.concat(objects.readZData(entry.oid).pipe(Stream.map(tap))),
        ),
      ),
    );
    const trailer = Stream.sync(() => sha.digest());
    return header.pipe(Stream.concat(body), Stream.concat(trailer));
  });

// ─────────────────────────────────────────────────────────────────────────────
// Pack ingest (DESIGN.md §3.6) — buffered v1, RandomAccess seam is the buffer
// ─────────────────────────────────────────────────────────────────────────────

/** A commit staged by an ingest, with what the commit graph needs. */
export interface StagedCommitInfo {
  readonly oid: Oid;
  readonly tree: Oid;
  readonly parents: ReadonlyArray<Oid>;
  readonly commitTime: number;
}

/** The result of a successful pack ingest. */
export interface IngestResult {
  /** Objects in the pack (including already-existing re-pushed ones). */
  readonly objectCount: number;
  /** The pack's trailer checksum (hex). */
  readonly packSha: string;
  /** Staged commits (commit-graph rows are inserted at finalize). */
  readonly commits: ReadonlyArray<StagedCommitInfo>;
  /** Oids referenced by staged trees/tags + commit trees (hard edges). */
  readonly referenced: ReadonlyArray<Oid>;
  /** Oids referenced as commit parents (soft under shallow import). */
  readonly referencedParents: ReadonlyArray<Oid>;
}

/** Bounded LRU of inflated contents shared across delta resolution. */
const makeContentCache = (budget: number) => {
  const map = new Map<string, Uint8Array>();
  let total = 0;
  return {
    get: (key: string): Uint8Array | undefined => {
      const value = map.get(key);
      if (value !== undefined) {
        map.delete(key);
        map.set(key, value);
      }
      return value;
    },
    set: (key: string, value: Uint8Array): void => {
      if (value.byteLength > budget || map.has(key)) return;
      map.set(key, value);
      total += value.byteLength;
      for (const [k, v] of map) {
        if (total <= budget) break;
        map.delete(k);
        total -= v.byteLength;
      }
    },
  };
};

/** Delta-resolution content cache budget (DESIGN.md §3.6): 20 MiB. */
const CACHE_BUDGET = 20 * 1024 * 1024;
/** Maximum delta-chain depth tolerated (git's own default is 50). */
const MAX_DELTA_DEPTH = 64;

interface RawEntry {
  readonly offset: number;
  readonly kind: "object" | "ofs" | "ref";
  /** Real object type for `kind: "object"`. */
  readonly type: ObjectType | undefined;
  /** Header size (object size, or delta payload size for deltas). */
  readonly declaredSize: number;
  /** Where this entry's zlib stream starts. */
  readonly zstart: number;
  /** Exact compressed span length. */
  readonly zlen: number;
  readonly baseOffset: number | undefined;
  readonly baseOid: Oid | undefined;
  /** Filled once resolved. */
  oid: Oid | undefined;
  resolvedType: ObjectType | undefined;
}

/** Options of {@link ingestPack}. */
export interface IngestOptions {
  readonly store: ObjectStore;
  readonly pushId: string;
  /**
   * Shallow-import mode: commit parents may be absent (they become walk
   * boundaries); trees/blobs/tags must still be fully connected.
   */
  readonly allowMissingParents?: boolean | undefined;
}

/**
 * Single-pass buffered pack ingest (DESIGN.md §3.6): parse entries,
 * store non-delta compressed spans **verbatim**, resolve ofs/ref deltas
 * (thin bases from the live store), enforce the 64 MiB object cap, verify
 * the trailer SHA-1, and stage everything under `pushId`.
 *
 * The v1.x streaming upgrade seam: this function's only view of the pack
 * is `pack: Uint8Array` random access — swapping in an R2-backed
 * `RandomAccess` touches this implementation, not the protocol drivers.
 */
/**
 * Ingests a pack from a {@link RandomAccess} source — the path that has **no
 * size cap** (DESIGN.md §3.6). Memory is bounded by the source's read
 * window and the delta LRU rather than by the pack, so the source can be an
 * R2 object of any size (see `store/PackSource.ts`).
 *
 * Delegates the wire-format work to the pure `PackParser` (which the pack
 * fixtures in `test/pack.test.ts` cover directly) and does the repo-side
 * work in its sink: stage the object, and record commit-graph edges.
 * Blobs are staged without inflating — only commits, trees and tags need
 * their content parsed, and those are small.
 */
export const ingestPackFrom = (
  source: RandomAccess,
  options: IngestOptions,
): Effect.Effect<IngestResult, PackIngestError | StoreError> =>
  Effect.gen(function* () {
    const { store, pushId } = options;
    const commits: Array<StagedCommitInfo> = [];
    const referenced = new Set<Oid>();
    const referencedParents = new Set<Oid>();

    const record = Effect.fn(function* (
      oid: Oid,
      type: ObjectType,
      content: Uint8Array,
    ) {
      switch (type) {
        case ObjectType.commit: {
          const parsed = yield* parseCommit(content).pipe(
            Effect.mapError(
              (error) =>
                new PackIngestError({
                  reason: `bad commit ${oid}: ${error.reason}`,
                }),
            ),
          );
          commits.push({
            oid,
            tree: parsed.tree,
            parents: parsed.parents,
            commitTime: parsed.committer.when,
          });
          referenced.add(parsed.tree);
          for (const parent of parsed.parents) referencedParents.add(parent);
          return;
        }
        case ObjectType.tree: {
          const parsed = yield* parseTree(content).pipe(
            Effect.mapError(
              (error) =>
                new PackIngestError({
                  reason: `bad tree ${oid}: ${error.reason}`,
                }),
            ),
          );
          for (const entry of parsed) {
            if (treeEntryKind(entry.mode) !== "commit") {
              referenced.add(entry.oid);
            }
          }
          return;
        }
        case ObjectType.tag: {
          const parsed = yield* parseTag(content).pipe(
            Effect.mapError(
              (error) =>
                new PackIngestError({
                  reason: `bad tag ${oid}: ${error.reason}`,
                }),
            ),
          );
          referenced.add(parsed.object);
          return;
        }
        case ObjectType.blob:
          return;
      }
    });

    const summary = yield* PackParser.ingestPack({
      source,
      store,
      maxObjectSize: MAX_OBJECT_SIZE,
      sink: (entry) =>
        Effect.gen(function* () {
          yield* store.insertStaged(pushId, {
            oid: entry.oid,
            type: entry.type,
            size: entry.size,
            zdata: entry.zdata,
          });
          if (entry.type === ObjectType.blob) return;
          const content = yield* Zlib.inflate(entry.zdata).pipe(
            Effect.mapError(
              (error) => new PackIngestError({ reason: error.reason }),
            ),
          );
          yield* record(entry.oid, entry.type, content);
        }),
    }).pipe(
      Effect.mapError((error) =>
        error._tag === "StoreError" || error._tag === "PackIngestError"
          ? error
          : new PackIngestError({ reason: packParserReason(error) }),
      ),
    );

    return {
      objectCount: summary.count,
      // The parser verifies the trailer itself; the checksum is not used
      // downstream, so it is not re-derived here.
      packSha: "",
      commits,
      referenced: Array.from(referenced),
      referencedParents: Array.from(referencedParents),
    } satisfies IngestResult;
  });

/** Renders a `PackParser` failure as an in-band `unpack <reason>` string. */
const packParserReason = (error: {
  readonly _tag: string;
  readonly reason?: string;
  readonly expected?: string;
  readonly actual?: string;
  readonly baseOid?: string;
  readonly size?: number;
  readonly limit?: number;
}): string => {
  switch (error._tag) {
    case "PackChecksumMismatch":
      return "pack checksum mismatch";
    case "MissingDeltaBaseError":
      return `missing delta base ${error.baseOid ?? ""}`.trim();
    case "ObjectTooLargeError":
      return `object too large (${error.size ?? 0} > ${error.limit ?? 0})`;
    default:
      return error.reason ?? error._tag;
  }
};

export const ingestPack = (
  pack: Uint8Array,
  options: IngestOptions,
): Effect.Effect<IngestResult, PackIngestError | StoreError> =>
  Effect.gen(function* () {
    const { store, pushId } = options;
    if (pack.length < 12 + 20) {
      return yield* new PackIngestError({ reason: "pack too small" });
    }
    if (
      pack[0] !== 0x50 ||
      pack[1] !== 0x41 ||
      pack[2] !== 0x43 ||
      pack[3] !== 0x4b
    ) {
      return yield* new PackIngestError({ reason: "bad pack signature" });
    }
    const view = new DataView(pack.buffer, pack.byteOffset, pack.byteLength);
    const version = view.getUint32(4);
    if (version !== 2) {
      return yield* new PackIngestError({
        reason: `unsupported pack version ${version}`,
      });
    }
    const count = view.getUint32(8);

    // Trailer verification first — cheap, and everything after assumes an
    // intact buffer.
    const trailer = bytesToHex(pack.subarray(pack.length - 20));
    const sha = makeSha1();
    sha.update(pack.subarray(0, pack.length - 20));
    const actual = sha.digestHex();
    if (actual !== trailer) {
      return yield* new PackIngestError({ reason: "pack checksum mismatch" });
    }

    const cache = makeContentCache(CACHE_BUDGET);
    const entries: Array<RawEntry> = [];
    const byOffset = new Map<number, RawEntry>();
    const byOid = new Map<Oid, RawEntry>();

    const commits: Array<StagedCommitInfo> = [];
    const referenced = new Set<Oid>();
    const referencedParents = new Set<Oid>();

    /** Record graph facts + referenced edges for a resolved object. */
    const recordObject = Effect.fn(function* (
      oid: Oid,
      type: ObjectType,
      content: Uint8Array,
    ) {
      switch (type) {
        case ObjectType.commit: {
          const parsed = yield* parseCommit(content).pipe(
            Effect.mapError(
              (error) =>
                new PackIngestError({
                  reason: `bad commit ${oid}: ${error.reason}`,
                }),
            ),
          );
          commits.push({
            oid,
            tree: parsed.tree,
            parents: parsed.parents,
            commitTime: parsed.committer.when,
          });
          referenced.add(parsed.tree);
          for (const parent of parsed.parents) {
            referencedParents.add(parent);
          }
          return;
        }
        case ObjectType.tree: {
          const parsed = yield* parseTree(content).pipe(
            Effect.mapError(
              (error) =>
                new PackIngestError({
                  reason: `bad tree ${oid}: ${error.reason}`,
                }),
            ),
          );
          for (const entry of parsed) {
            if (treeEntryKind(entry.mode) !== "commit") {
              referenced.add(entry.oid);
            }
          }
          return;
        }
        case ObjectType.tag: {
          const parsed = yield* parseTag(content).pipe(
            Effect.mapError(
              (error) =>
                new PackIngestError({
                  reason: `bad tag ${oid}: ${error.reason}`,
                }),
            ),
          );
          referenced.add(parsed.object);
          return;
        }
        case ObjectType.blob:
          return;
      }
    });

    const stage = Effect.fn(function* (
      oid: Oid,
      type: ObjectType,
      content: Uint8Array,
      zdata: Uint8Array,
    ) {
      const staged: StagedObject = {
        oid,
        type,
        size: content.length,
        zdata,
      };
      yield* store.insertStaged(pushId, staged);
      yield* recordObject(oid, type, content);
    });

    // ── Pass 1: scan entries, stage non-deltas verbatim ─────────────────────
    let offset = 12;
    const zlibToIngest = (error: Zlib.ZlibError): PackIngestError =>
      new PackIngestError({ reason: error.reason });

    for (let i = 0; i < count; i++) {
      const entryStart = offset;
      let header;
      try {
        header = decodeTypeSize(pack, offset);
      } catch (error) {
        return yield* new PackIngestError({
          reason: `entry ${i}: ${String(error)}`,
        });
      }
      if (!isDeltaType(header.type)) {
        if (header.size > MAX_OBJECT_SIZE) {
          return yield* new PackIngestError({ reason: "object too large" });
        }
        const inflated = yield* Zlib.inflateEntry(pack, header.next, {
          maxOutput: header.size,
        }).pipe(Effect.mapError(zlibToIngest));
        if (inflated.content.length !== header.size) {
          return yield* new PackIngestError({
            reason: `entry ${i}: size mismatch (${inflated.content.length} != ${header.size})`,
          });
        }
        const type = header.type as ObjectType;
        const oid = yield* hashObject(type, inflated.content);
        const zdata = pack.subarray(
          header.next,
          header.next + inflated.bytesConsumed,
        );
        const entry: RawEntry = {
          offset: entryStart,
          kind: "object",
          type,
          declaredSize: header.size,
          zstart: header.next,
          zlen: inflated.bytesConsumed,
          baseOffset: undefined,
          baseOid: undefined,
          oid,
          resolvedType: type,
        };
        entries.push(entry);
        byOffset.set(entryStart, entry);
        byOid.set(oid, entry);
        cache.set(oid, inflated.content);
        yield* stage(oid, type, inflated.content, zdata);
        offset = header.next + inflated.bytesConsumed;
      } else {
        let zstart = header.next;
        let baseOffset: number | undefined;
        let baseOid: Oid | undefined;
        if (header.type === 6) {
          let decoded;
          try {
            decoded = decodeOfsDeltaOffset(pack, header.next);
          } catch (error) {
            return yield* new PackIngestError({
              reason: `entry ${i}: ${String(error)}`,
            });
          }
          baseOffset = entryStart - decoded.value;
          if (baseOffset < 12) {
            return yield* new PackIngestError({
              reason: `entry ${i}: ofs-delta base offset out of range`,
            });
          }
          zstart = decoded.next;
        } else {
          if (header.next + 20 > pack.length) {
            return yield* new PackIngestError({
              reason: `entry ${i}: truncated ref-delta base id`,
            });
          }
          baseOid = bytesToHex(pack.subarray(header.next, header.next + 20));
          zstart = header.next + 20;
        }
        const inflated = yield* Zlib.inflateEntry(pack, zstart, {
          maxOutput: header.size,
        }).pipe(Effect.mapError(zlibToIngest));
        const entry: RawEntry = {
          offset: entryStart,
          kind: header.type === 6 ? "ofs" : "ref",
          type: undefined,
          declaredSize: header.size,
          zstart,
          zlen: inflated.bytesConsumed,
          baseOffset,
          baseOid,
          oid: undefined,
          resolvedType: undefined,
        };
        entries.push(entry);
        byOffset.set(entryStart, entry);
        offset = zstart + inflated.bytesConsumed;
      }
      if (offset > pack.length - 20) {
        return yield* new PackIngestError({
          reason: `entry ${i}: pack truncated`,
        });
      }
    }
    if (offset !== pack.length - 20) {
      return yield* new PackIngestError({
        reason: "trailing garbage between entries and pack trailer",
      });
    }

    // ── Pass 2: resolve deltas (bases may chain; thin bases from store) ─────
    const contentOf = (
      entry: RawEntry,
      depth: number,
    ): Effect.Effect<
      { readonly content: Uint8Array; readonly type: ObjectType },
      PackIngestError | StoreError
    > =>
      Effect.gen(function* () {
        if (depth > MAX_DELTA_DEPTH) {
          return yield* new PackIngestError({ reason: "delta chain too deep" });
        }
        if (entry.oid !== undefined && entry.resolvedType !== undefined) {
          const cached = cache.get(entry.oid);
          if (cached !== undefined) {
            return { content: cached, type: entry.resolvedType };
          }
        }
        if (entry.kind === "object") {
          const inflated = yield* Zlib.inflateEntry(pack, entry.zstart, {
            maxOutput: entry.declaredSize,
          }).pipe(Effect.mapError(zlibToIngest));
          if (entry.oid !== undefined) cache.set(entry.oid, inflated.content);
          return { content: inflated.content, type: entry.type! };
        }
        // delta — resolve the base first
        const base = yield* Effect.gen(function* () {
          if (entry.kind === "ofs") {
            const baseEntry = byOffset.get(entry.baseOffset!);
            if (baseEntry === undefined) {
              return yield* new PackIngestError({
                reason: "ofs-delta base is not an entry boundary",
              });
            }
            return yield* contentOf(baseEntry, depth + 1);
          }
          const inPack = byOid.get(entry.baseOid!);
          if (inPack !== undefined) {
            return yield* contentOf(inPack, depth + 1);
          }
          // Thin base: must exist in the live store.
          const meta = yield* store.getMeta(entry.baseOid!);
          if (meta === undefined) {
            return yield* new PackIngestError({
              reason: `missing thin-pack base ${entry.baseOid}`,
            });
          }
          if (meta.size > MAX_OBJECT_SIZE) {
            return yield* new PackIngestError({ reason: "object too large" });
          }
          const content = yield* store.readContent(entry.baseOid!);
          cache.set(entry.baseOid!, content);
          return { content, type: meta.type };
        });
        const delta = yield* Zlib.inflateEntry(pack, entry.zstart, {
          maxOutput: entry.declaredSize,
        }).pipe(Effect.mapError(zlibToIngest));
        const content = yield* applyDelta(base.content, delta.content).pipe(
          Effect.mapError(
            (error) => new PackIngestError({ reason: error.reason }),
          ),
        );
        if (content.length > MAX_OBJECT_SIZE) {
          return yield* new PackIngestError({ reason: "object too large" });
        }
        return { content, type: base.type };
      });

    for (const entry of entries) {
      if (entry.kind === "object" || entry.oid !== undefined) continue;
      const resolved = yield* contentOf(entry, 0);
      const oid = yield* hashObject(resolved.type, resolved.content);
      entry.oid = oid;
      entry.resolvedType = resolved.type;
      byOid.set(oid, entry);
      cache.set(oid, resolved.content);
      const zdata = yield* Zlib.deflate(resolved.content).pipe(
        Effect.mapError(zlibToIngest),
      );
      yield* stage(oid, resolved.type, resolved.content, zdata);
    }

    return {
      objectCount: count,
      packSha: trailer,
      commits,
      referenced: Array.from(referenced),
      referencedParents: Array.from(referencedParents),
    } satisfies IngestResult;
  });

// ─────────────────────────────────────────────────────────────────────────────
// Small shared helpers
// ─────────────────────────────────────────────────────────────────────────────

const asOid = (s: string): ApiOid => s as ApiOid;

const SCOPE_RANK: Record<TokenScope, number> = { read: 0, write: 1, admin: 2 };

const isTokenScope = (s: string): s is TokenScope =>
  s === "read" || s === "write" || s === "admin";

/** Decompresses a request body when it is gzip (header or 1f8b sniff). */
export const gunzipIfNeeded = (
  body: Uint8Array,
  contentEncoding: string | undefined,
): Effect.Effect<Uint8Array, PackIngestError> => {
  const looksGzip = body.length >= 2 && body[0] === 0x1f && body[1] === 0x8b;
  if (contentEncoding?.toLowerCase() !== "gzip" && !looksGzip) {
    return Effect.succeed(body);
  }
  if (!looksGzip) {
    // Content-Encoding claimed gzip but the magic disagrees — trust bytes.
    return Effect.succeed(body);
  }
  return Effect.tryPromise({
    try: () =>
      new Response(
        new Response(body as BodyInit).body!.pipeThrough(
          new DecompressionStream("gzip"),
        ),
      )
        .arrayBuffer()
        .then((buffer) => new Uint8Array(buffer)),
    catch: (error) =>
      new PackIngestError({ reason: `gzip decompression failed: ${error}` }),
  });
};

const noCache = { "cache-control": "no-cache" } as const;

// ─────────────────────────────────────────────────────────────────────────────
// The Durable Object
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The per-repo Durable Object class (modular form). The runtime
 * implementation is {@link GitRepoLive}; the hosting Worker provides it via
 * `Effect.provide(GitRepoLive)` and consumers `yield* GitRepo` for the
 * namespace handle.
 */
export class GitRepo extends Cloudflare.DurableObject<GitRepo, GitRepoShape>()(
  "GitRepo",
  {
    // Every tagged error the RPC surface can fail with: the calling Worker
    // reconstructs real class instances from the RPC wire (see the
    // `DurableObjectProps.errors` doc), so catchTag/instanceof/HttpApi
    // encoding all see the classes the DO actually failed with.
    errors: [
      Unauthorized,
      Forbidden,
      ReadOnlyRepo,
      RepoNotFound,
      RefNotFound,
      RefConflict,
      ObjectNotFound,
      WrongObjectType,
      TokenNotFound,
      StoreError,
      PackIngestError,
      WireProtocolError,
    ],
  },
) {}

/**
 * The shared R2 bucket resource holding oversize loose objects and (v1.1)
 * compacted packs, keyed `{repoId}/...` (DESIGN.md §3.2).
 */
export const GitObjectsBucket = Cloudflare.R2.Bucket("GitObjects");

/** The stub type of a sibling repo (used by the fork job). */
type RepoStub = ReturnType<
  Cloudflare.Workers.DurableObject<GitRepoShape>["getByName"]
>;

/**
 * The Repo DO implementation Layer. Requires the shared R2 bucket binding
 * (`Cloudflare.R2.BucketReadWrite`, provided as
 * `Cloudflare.R2.ReadWriteBucketBinding` on the Worker) and the
 * {@link Registry} namespace.
 */
export const GitRepoLive = GitRepo.make(
  Effect.gen(function* () {
    // ── Outer init: resolve bindings + namespaces (runs at plan time too) ──
    const state = yield* Cloudflare.DurableObjectState;
    const bucket = yield* Cloudflare.R2.ReadWriteBucket(GitObjectsBucket);
    const registry = yield* Registry;
    const selfNamespace = yield* Cloudflare.DurableObjectScope;

    return Effect.gen(function* () {
      // ── Inner init: per-instance construction (runtime only) ────────────
      const sql = makeSqlClient(state);
      yield* initRepoSchema(sql).pipe(Effect.orDie);
      const pushSemaphore = yield* Semaphore.make(1);

      // ── config helpers ───────────────────────────────────────────────────
      const getConfig = (key: string) =>
        sql
          .first<{ value: string }>(
            `SELECT value FROM config WHERE key = ?`,
            key,
          )
          .pipe(Effect.map((row) => row?.value));

      const setConfig = (key: string, value: string) =>
        sql.run(
          `INSERT INTO config (key, value) VALUES (?, ?)
           ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
          key,
          value,
        );

      const readMeta: Effect.Effect<RepoMetaData | undefined, StoreError> =
        Effect.gen(function* () {
          const rows = yield* sql.all<{ key: string; value: string }>(
            `SELECT key, value FROM config`,
          );
          const map = new Map(rows.map((row) => [row.key, row.value]));
          const repoId = map.get("repo_id");
          if (repoId === undefined) return undefined;
          const stats = yield* sql.all<{
            location: string;
            n: number;
            bytes: number;
          }>(
            `SELECT location, COUNT(*) AS n, COALESCE(SUM(zsize), 0) AS bytes
               FROM objects WHERE staged_push IS NULL GROUP BY location`,
          );
          const byLocation = new Map(stats.map((row) => [row.location, row]));
          return {
            repoId,
            owner: map.get("owner") ?? "",
            name: map.get("name") ?? "",
            defaultBranch: map.get("default_branch") ?? "main",
            description: map.get("description") ?? null,
            readOnly: map.get("read_only") === "1",
            forkOf: map.get("fork_of") ?? null,
            status: (map.get("status") ?? "ready") as RepoStatus,
            createdAt: Number(map.get("created_at") ?? 0),
            objects: {
              loose: byLocation.get("row")?.n ?? 0,
              packed: byLocation.get("pack")?.n ?? 0,
              r2: byLocation.get("r2")?.n ?? 0,
              bytes: stats.reduce((sum, row) => sum + row.bytes, 0),
            },
          } satisfies RepoMetaData;
        });

      const requireMeta: Effect.Effect<
        RepoMetaData,
        RepoNotFound | StoreError
      > = readMeta.pipe(
        Effect.flatMap((meta) =>
          meta === undefined
            ? Effect.fail(new RepoNotFound({ owner: "", repo: "" }))
            : Effect.succeed(meta),
        ),
      );

      /** The object store, keyed by the current repoId. */
      const storeFor = (repoId: string): ObjectStore =>
        makeObjectStore({ sql, bucket, repoId });

      // ── auth ─────────────────────────────────────────────────────────────
      const verifyTokenHash = Effect.fn(function* (
        tokenHash: string,
        required: TokenScope,
      ) {
        const row = yield* sql.first<TokenRow>(
          `SELECT * FROM tokens WHERE token_hash = ?`,
          tokenHash,
        );
        const now = Date.now();
        if (row === undefined) {
          return yield* new Unauthorized();
        }
        if (row.expires_at !== null && row.expires_at <= now) {
          return yield* new Unauthorized();
        }
        if (!isTokenScope(row.scope)) {
          return yield* new StoreError({
            reason: `corrupt token scope '${row.scope}'`,
          });
        }
        if (SCOPE_RANK[row.scope] < SCOPE_RANK[required]) {
          return yield* new Forbidden({ required });
        }
        // last_used_at, throttled to once per hour
        if (row.last_used_at === null || now - row.last_used_at > 3_600_000) {
          yield* sql.run(
            `UPDATE tokens SET last_used_at = ? WHERE id = ?`,
            now,
            row.id,
          );
        }
        return {
          id: row.id,
          name: row.name,
          scope: row.scope,
          createdAt: row.created_at,
          expiresAt: row.expires_at,
          lastUsedAt: row.last_used_at ?? now,
        } satisfies TokenData;
      });

      /** Enforces the auth matrix for one RPC (admin key passes everything). */
      const authorize = Effect.fn(function* (
        auth: CallerAuth,
        required: TokenScope,
      ) {
        if (auth.kind === "admin") return;
        const hash = yield* hashToken(auth.token);
        yield* verifyTokenHash(hash, required);
      });

      const mintRepoToken = Effect.fn(function* (input: {
        readonly name: string;
        readonly scope: TokenScope;
        readonly ttlSeconds?: number | undefined;
      }) {
        const secret = yield* mintToken;
        const hash = yield* hashToken(secret);
        const id = yield* ulid();
        const createdAt = Date.now();
        const expiresAt =
          input.ttlSeconds === undefined
            ? null
            : createdAt + input.ttlSeconds * 1000;
        yield* sql.run(
          `INSERT INTO tokens (id, token_hash, name, scope, created_at, expires_at, last_used_at)
           VALUES (?, ?, ?, ?, ?, ?, NULL)`,
          id,
          hash,
          input.name,
          input.scope,
          createdAt,
          expiresAt,
        );
        return {
          id,
          name: input.name,
          scope: input.scope,
          createdAt,
          expiresAt,
          lastUsedAt: null,
          token: secret,
        } satisfies CreatedTokenData;
      });

      // ── refs ─────────────────────────────────────────────────────────────
      /** Peels a (possibly annotated-tag) oid to its final non-tag target. */
      const peelOid = (
        repoId: string,
        oid: Oid,
      ): Effect.Effect<Oid | undefined, StoreError> =>
        Effect.gen(function* () {
          const objects = storeFor(repoId);
          let current = oid;
          for (let hops = 0; hops < 16; hops++) {
            const meta = yield* objects.getMeta(current);
            if (meta === undefined) return undefined;
            if (meta.type !== ObjectType.tag) {
              return hops === 0 ? undefined : current;
            }
            const content = yield* objects.readContent(current);
            const parsed = yield* parseTag(content).pipe(
              Effect.mapError(
                (error) => new StoreError({ reason: error.reason }),
              ),
            );
            current = parsed.object;
          }
          return current;
        });

      const listAllRefs = (
        repoId: string,
        prefix?: string | undefined,
      ): Effect.Effect<Array<RefData>, StoreError> =>
        Effect.gen(function* () {
          const rows =
            prefix === undefined || prefix.length === 0
              ? yield* sql.all<RefRow>(
                  `SELECT name, oid FROM refs ORDER BY name`,
                )
              : yield* sql.all<RefRow>(
                  `SELECT name, oid FROM refs WHERE name >= ? AND name < ? ORDER BY name`,
                  prefix,
                  // next lexicographic sibling of the prefix
                  `${prefix.slice(0, -1)}${String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1)}`,
                );
          const out: Array<RefData> = [];
          for (const row of rows) {
            const peeled = row.name.startsWith("refs/tags/")
              ? yield* peelOid(repoId, row.oid)
              : undefined;
            out.push(
              peeled === undefined
                ? { name: row.name, oid: row.oid }
                : { name: row.name, oid: row.oid, peeled },
            );
          }
          return out;
        });

      /**
       * The single transactional ref-CAS path (DESIGN.md §3.4). All ref
       * mutations — push commands, REST writes, import finalize — run here.
       */
      interface RefResult {
        readonly ref: string;
        readonly ok: boolean;
        readonly reason?: string | undefined;
      }
      const finalizeRefTxn = (options: {
        readonly commands: ReadonlyArray<RefCommand>;
        readonly atomic: boolean;
        /** Skip the old-oid CAS entirely (import finalize). */
        readonly unconditional?: boolean | undefined;
        readonly pushId?: string | undefined;
        readonly graph: ReadonlyArray<{
          readonly oid: string;
          readonly tree: string;
          readonly gen: number;
          readonly commitTime: number;
          readonly parents: ReadonlyArray<string>;
        }>;
      }): Effect.Effect<Array<RefResult>, StoreError> =>
        sql.transactionSync((raw) => {
          const currentOf = (name: string): string => {
            const rows = raw
              .exec<RefRow>(`SELECT name, oid FROM refs WHERE name = ?`, name)
              .toArray();
            return rows.length > 0 ? rows[0]!.oid : ZERO_OID;
          };
          const results: Array<RefResult> = [];
          // atomic: verify every CAS before writing anything
          if (options.atomic && options.unconditional !== true) {
            const failed = options.commands.some(
              (cmd) => currentOf(cmd.ref) !== cmd.oldOid,
            );
            if (failed) {
              for (const cmd of options.commands) {
                results.push({
                  ref: cmd.ref,
                  ok: false,
                  reason:
                    currentOf(cmd.ref) === cmd.oldOid
                      ? "atomic transaction failed"
                      : "fetch first",
                });
              }
              return results;
            }
          }
          let anyOk = false;
          for (const cmd of options.commands) {
            if (
              options.unconditional !== true &&
              currentOf(cmd.ref) !== cmd.oldOid
            ) {
              results.push({ ref: cmd.ref, ok: false, reason: "fetch first" });
              continue;
            }
            if (cmd.newOid === ZERO_OID) {
              raw.exec(`DELETE FROM refs WHERE name = ?`, cmd.ref);
            } else {
              raw.exec(
                `INSERT INTO refs (name, oid) VALUES (?, ?)
                 ON CONFLICT (name) DO UPDATE SET oid = excluded.oid`,
                cmd.ref,
                cmd.newOid,
              );
            }
            results.push({ ref: cmd.ref, ok: true });
            anyOk = true;
          }
          if (anyOk || options.commands.length === 0) {
            if (options.pushId !== undefined) {
              raw.exec(
                `UPDATE objects SET staged_push = NULL WHERE staged_push = ?`,
                options.pushId,
              );
              raw.exec(
                `UPDATE pushes SET state = 'committed' WHERE push_id = ?`,
                options.pushId,
              );
            }
            for (const commit of options.graph) {
              raw.exec(
                `INSERT OR IGNORE INTO commits (oid, tree, gen, commit_time) VALUES (?, ?, ?, ?)`,
                commit.oid,
                commit.tree,
                commit.gen,
                commit.commitTime,
              );
              commit.parents.forEach((parent, ord) => {
                raw.exec(
                  `INSERT OR IGNORE INTO commit_parents (oid, parent, ord) VALUES (?, ?, ?)`,
                  commit.oid,
                  parent,
                  ord,
                );
              });
            }
            // First-branch-push default branch fixup: if the configured
            // default branch does not exist but a branch was just created,
            // repoint the default at it (prefer main/master).
            const configured = raw
              .exec<{ value: string }>(
                `SELECT value FROM config WHERE key = 'default_branch'`,
              )
              .toArray()[0]?.value;
            if (configured !== undefined) {
              const exists = raw
                .exec<RefRow>(
                  `SELECT name, oid FROM refs WHERE name = ?`,
                  `refs/heads/${configured}`,
                )
                .toArray();
              if (exists.length === 0) {
                const branches = raw
                  .exec<RefRow>(
                    `SELECT name, oid FROM refs WHERE name LIKE 'refs/heads/%' ORDER BY name`,
                  )
                  .toArray()
                  .map((row) => row.name.slice("refs/heads/".length));
                const pick =
                  branches.find((b) => b === "main") ??
                  branches.find((b) => b === "master") ??
                  branches[0];
                if (pick !== undefined) {
                  raw.exec(
                    `UPDATE config SET value = ? WHERE key = 'default_branch'`,
                    pick,
                  );
                }
              }
            }
          }
          return results;
        });

      /** Computes gen/commit_time rows for staged commits (§3.6 step 6). */
      const computeGraphRows = (
        staged: ReadonlyArray<StagedCommitInfo>,
      ): Effect.Effect<
        Array<{
          oid: string;
          tree: string;
          gen: number;
          commitTime: number;
          parents: ReadonlyArray<string>;
        }>,
        StoreError
      > =>
        Effect.gen(function* () {
          const stagedByOid = new Map(staged.map((c) => [c.oid, c]));
          const externalParents = Array.from(
            new Set(
              staged.flatMap((c) =>
                c.parents.filter((p) => !stagedByOid.has(p)),
              ),
            ),
          );
          const liveGens = new Map<string, number>();
          if (externalParents.length > 0) {
            const rows = yield* sql.inChunks<{ oid: string; gen: number }>(
              (ph) => `SELECT oid, gen FROM commits WHERE oid IN (${ph})`,
              externalParents,
            );
            for (const row of rows) liveGens.set(row.oid, row.gen);
          }
          const gens = new Map<string, number>();
          const genOf = (oid: string, depth: number): number => {
            const known = gens.get(oid);
            if (known !== undefined) return known;
            const live = liveGens.get(oid);
            if (live !== undefined) return live;
            const commit = stagedByOid.get(oid);
            // Missing parent (shallow boundary) counts as gen 0.
            if (commit === undefined || depth > 100_000) return 0;
            const gen =
              commit.parents.length === 0
                ? 1
                : Math.max(...commit.parents.map((p) => genOf(p, depth + 1))) +
                  1;
            gens.set(oid, gen);
            return gen;
          };
          return staged.map((commit) => ({
            oid: commit.oid,
            tree: commit.tree,
            gen: genOf(commit.oid, 0),
            commitTime: commit.commitTime,
            parents: commit.parents,
          }));
        });

      // ── alarm scheduling ─────────────────────────────────────────────────
      const armAlarmAt = (time: number) =>
        Effect.gen(function* () {
          const existing = yield* state.storage.getAlarm();
          if (existing === null || existing > time) {
            yield* state.storage.setAlarm(time);
          }
        });

      const upsertJob = (kind: string, detail: string | null) =>
        sql.run(
          `INSERT INTO jobs (kind, state, detail, updated_at) VALUES (?, 'running', ?, ?)
           ON CONFLICT (kind) DO UPDATE SET state = 'running', detail = excluded.detail, updated_at = excluded.updated_at`,
          kind,
          detail,
          Date.now(),
        );

      // ── bootstrap (create / fork / import) ───────────────────────────────
      const seedConfig = Effect.fn(function* (
        input: InitRepoInput,
        status: RepoStatus,
      ) {
        const createdAt = Date.now();
        yield* setConfig("repo_id", input.repoId);
        yield* setConfig("owner", input.owner.toLowerCase());
        yield* setConfig("name", input.name.toLowerCase());
        yield* setConfig("default_branch", input.defaultBranch);
        if (input.description !== null) {
          yield* setConfig("description", input.description);
        }
        yield* setConfig("read_only", input.readOnly ? "1" : "0");
        if (input.forkOf !== null) {
          yield* setConfig("fork_of", input.forkOf);
        }
        yield* setConfig("status", status);
        yield* readMeta.pipe(
          Effect.flatMap((meta) =>
            meta === undefined ? Effect.void : syncSummary(meta),
          ),
          Effect.ignore,
        );
        const existing = yield* getConfig("created_at");
        if (existing === undefined) {
          yield* setConfig("created_at", String(createdAt));
        }
        const meta = yield* readMeta;
        return meta!;
      });

      const bootstrap = Effect.fn(function* (
        input: InitRepoInput,
        status: RepoStatus,
      ) {
        const meta = yield* seedConfig(input, status);
        const token = yield* mintRepoToken({
          name: "bootstrap",
          scope: "write",
        });
        return { meta, token } satisfies InitRepoResult;
      });

      // ── wire protocol drivers ────────────────────────────────────────────

      /** Parses `/:owner/:repo[.git]/<endpoint>` out of the request URL. */
      const parseWirePath = (
        url: string,
      ):
        | {
            readonly owner: string;
            readonly repo: string;
            readonly endpoint: string;
            readonly service: string | undefined;
          }
        | undefined => {
        const parsed = new URL(url, "http://repo");
        const segments = parsed.pathname.split("/").filter(Boolean);
        if (segments.length < 3) return undefined;
        const owner = decodeURIComponent(segments[0]!).toLowerCase();
        let repo = decodeURIComponent(segments[1]!).toLowerCase();
        if (repo.endsWith(".git")) repo = repo.slice(0, -4);
        const endpoint = segments.slice(2).join("/");
        return {
          owner,
          repo,
          endpoint,
          service: parsed.searchParams.get("service") ?? undefined,
        };
      };

      const wire401 = HttpServerResponse.empty({
        status: 401,
        headers: { "www-authenticate": WWW_AUTHENTICATE },
      });
      const wire503 = HttpServerResponse.empty({
        status: 503,
        headers: { "retry-after": "10" },
      });

      /** Authenticates a wire request; `undefined` = unauthenticated. */
      const wireAuth = (
        request: HttpServerRequest.HttpServerRequest,
        required: TokenScope,
      ): Effect.Effect<boolean, StoreError> =>
        Effect.gen(function* () {
          if (request.headers[ADMIN_HEADER] === "1") return true;
          const creds = parseBasicOrBearer(request.headers);
          if (creds === undefined) return false;
          const hash = yield* hashToken(Redacted.value(creds.token));
          const result = yield* verifyTokenHash(hash, required).pipe(
            Effect.map(() => true),
            Effect.catchTag("Unauthorized", () => Effect.succeed(false)),
            Effect.catchTag("Forbidden", () => Effect.succeed(false)),
          );
          return result;
        });

      /** GET info/refs — the v0 advertisement. */
      const handleInfoRefs = (
        request: HttpServerRequest.HttpServerRequest,
        service: string | undefined,
        meta: RepoMetaData,
      ) =>
        Effect.gen(function* () {
          if (service !== "git-upload-pack" && service !== "git-receive-pack") {
            return HttpServerResponse.text(
              "smart HTTP only (dumb protocol not supported)",
              { status: 400 },
            );
          }
          const required: TokenScope =
            service === "git-receive-pack" ? "write" : "read";
          const authed = yield* wireAuth(request, required);
          if (!authed) return wire401;
          const refs = yield* listAllRefs(meta.repoId);
          const body = buildAdvertisement({
            service,
            defaultBranch: meta.defaultBranch,
            refs,
          });
          return HttpServerResponse.uint8Array(body, {
            contentType: `application/x-${service}-advertisement`,
            headers: noCache,
          });
        });

      /** POST git-upload-pack — negotiation + pack (DESIGN.md §2.3). */
      const handleUploadPack = (
        request: HttpServerRequest.HttpServerRequest,
        meta: RepoMetaData,
      ) =>
        Effect.gen(function* () {
          const authed = yield* wireAuth(request, "read");
          if (!authed) return wire401;
          const rawBody = new Uint8Array(yield* request.arrayBuffer);
          const body = yield* gunzipIfNeeded(
            rawBody,
            request.headers["content-encoding"],
          );
          const resultType = "application/x-git-upload-pack-result";
          const errResponse = (message: string) =>
            HttpServerResponse.uint8Array(errPkt(message), {
              contentType: resultType,
              headers: noCache,
            });

          const parsed = yield* decodePktLines(body).pipe(
            Effect.flatMap(parseUploadPackRequest),
            Effect.map(Option.some),
            Effect.catchTag("PktLineError", (e) =>
              Effect.succeed(Option.none<UploadPackRequest>()).pipe(
                Effect.tap(() => Effect.logWarning(`upload-pack: ${e.reason}`)),
              ),
            ),
            Effect.catchTag("WireProtocolError", (e) =>
              Effect.succeed(Option.none<UploadPackRequest>()).pipe(
                Effect.tap(() => Effect.logWarning(`upload-pack: ${e.reason}`)),
              ),
            ),
          );
          if (Option.isNone(parsed)) {
            return errResponse("malformed upload-pack request");
          }
          const req = parsed.value;
          const objects = storeFor(meta.repoId);
          const sideband = req.capabilities.has("side-band-64k");
          const noDone = req.capabilities.has("no-done");

          const commons = yield* objects.filterExisting(req.haves);

          // Negotiation round without done and nothing in common: answer
          // NAK and wait for the next round (or done). EXCEPT when the
          // request carries `deepen` — the shallow/unshallow section must
          // precede the NAK ("fatal: expected shallow/unshallow, got NAK"
          // otherwise), so depth-carrying rounds fall through to the
          // closure computation below.
          if (!req.done && commons.length === 0 && req.depth === undefined) {
            return HttpServerResponse.uint8Array(pktText("NAK"), {
              contentType: resultType,
              headers: noCache,
            });
          }

          // Bundle fast path (DESIGN.md §12.2): a full clone whose wants are
          // all covered by the current bundle is served as bytes straight
          // from R2 — no closure walk, no per-object reads. `bundleCovers`
          // refuses anything with haves/depth/shallow state.
          const bundle = yield* readBundle;
          if (
            req.done &&
            bundle !== undefined &&
            bundleCovers(bundle, {
              wants: req.wants,
              haves: req.haves,
              depth: req.depth,
              clientShallow: req.clientShallow,
            })
          ) {
            // The DO does NOT stream the pack: it hands the Worker a
            // *marker* naming the R2 object, and the Worker streams those
            // bytes to the client itself (DESIGN.md §11, serving plane).
            // Auth and planning still happen here — where tokens and refs
            // live — but no pack byte transits this object, which is the
            // whole point of splitting the planes.
            const found = yield* bucket
              .head(bundle.key)
              .pipe(
                Effect.mapError(
                  (error) =>
                    new StoreError({ reason: `bundle: ${error.message}` }),
                ),
              );
            if (found !== null) {
              return HttpServerResponse.empty({
                status: 200,
                headers: {
                  ...noCache,
                  "content-type": resultType,
                  [BUNDLE_KEY_HEADER]: bundle.key,
                  [BUNDLE_HASH_HEADER]: bundle.refsHash,
                  [BUNDLE_COUNT_HEADER]: String(bundle.objectCount),
                  [BUNDLE_SIDEBAND_HEADER]: sideband ? "1" : "0",
                },
              });
            }
          }

          // A depth-limited import leaves the repo itself shallow; those
          // boundary commits must bound every walk and surface as
          // `shallow` lines so clones inherit the shallowness (fsck-clean).
          const shallowRoots = JSON.parse(
            (yield* getConfig("shallow_roots")) ?? "[]",
          ) as ReadonlyArray<string>;
          const closureResult = yield* Effect.result(
            computeClosure({ sql, objects })({
              wants: req.wants,
              haves: commons,
              depth: req.depth,
              clientShallow: req.clientShallow,
              repoShallow: shallowRoots,
            }),
          );
          if (Result.isFailure(closureResult)) {
            const error = closureResult.failure;
            return errResponse(
              error._tag === "ManifestTooLarge"
                ? `repository too large to serve in one pack (${error.count} > ${error.cap})`
                : error.reason,
            );
          }
          const closure = closureResult.success;

          // v0 clients only parse a shallow/unshallow section when THEY
          // brought shallowness into the exchange (`deepen` or `shallow`
          // lines). If this repo's own boundary truncated the walk for a
          // client that did neither, an unsolicited section would derail
          // its parser — refuse cleanly instead.
          const clientShallowAware =
            req.depth !== undefined || req.clientShallow.length > 0;
          if (closure.shallow.length > 0 && !clientShallowAware) {
            return errResponse(
              "repository has shallow history (imported with depth); clone with --depth",
            );
          }
          const head: Array<Uint8Array> = [];
          if (clientShallowAware) {
            for (const oid of closure.shallow) {
              head.push(pktText(`shallow ${oid}`));
            }
            for (const oid of closure.unshallow) {
              head.push(pktText(`unshallow ${oid}`));
            }
            head.push(flushPkt);
          }

          // Depth-carrying negotiation round with nothing in common and no
          // done yet: the response is the shallow section ALONE (lines +
          // flush) — no NAK, no pack. The stateless client buffers this
          // response, sends `done`, and expects the NEXT response to begin
          // with the shallow section again; a trailing NAK here would sit
          // in its buffer and derail that parse ("expected shallow list").
          if (!req.done && commons.length === 0) {
            return HttpServerResponse.uint8Array(concatBytes(head), {
              contentType: resultType,
              headers: noCache,
            });
          }
          const lastCommon = commons[commons.length - 1];
          if (req.done) {
            head.push(
              lastCommon === undefined
                ? pktText("NAK")
                : pktText(`ACK ${lastCommon}`),
            );
          } else {
            // !done implies commons.length > 0 (the NAK-only branch above).
            const ready = lastCommon ?? ZERO_OID;
            for (const common of commons) {
              head.push(pktText(`ACK ${common} common`));
            }
            head.push(pktText(`ACK ${ready} ready`));
            if (!noDone) {
              // Client will re-POST with done; no pack this round.
              return HttpServerResponse.uint8Array(concatBytes(head), {
                contentType: resultType,
                headers: noCache,
              });
            }
            head.push(pktText(`ACK ${ready}`));
          }

          const pack = packStream(closure.entries, objects);
          const bodyStream = sideband
            ? Stream.fromArray([
                concatBytes(head),
                progressMessage(
                  `Enumerating objects: ${closure.entries.length}, done.`,
                ),
              ]).pipe(
                Stream.concat(pack.pipe(wrapSideband(1))),
                Stream.concat(Stream.succeed(flushPkt)),
              )
            : Stream.fromArray([concatBytes(head)]).pipe(Stream.concat(pack));

          return HttpServerResponse.stream(bodyStream, {
            contentType: resultType,
            headers: noCache,
          });
        });

      /** POST git-receive-pack — ingest + transactional CAS (DESIGN.md §3.6). */
      const handleReceivePack = (
        request: HttpServerRequest.HttpServerRequest,
        meta: RepoMetaData,
      ) =>
        Effect.gen(function* () {
          const authed = yield* wireAuth(request, "write");
          if (!authed) return wire401;
          const resultType = "application/x-git-receive-pack-result";

          // No size check: a push of any size is accepted. Large ones are
          // parked in R2 and parsed from there (below) so ingest memory is
          // bounded by the read window rather than by the pack.
          const rawBody = new Uint8Array(yield* request.arrayBuffer);
          const bodyResult = yield* Effect.result(
            gunzipIfNeeded(rawBody, request.headers["content-encoding"]),
          );
          if (Result.isFailure(bodyResult)) {
            return HttpServerResponse.uint8Array(
              errPkt(bodyResult.failure.reason),
              { contentType: resultType, headers: noCache },
            );
          }
          const body = bodyResult.success;

          const parsedResult = yield* Effect.result(
            parseReceivePackRequest(body),
          );
          if (Result.isFailure(parsedResult)) {
            return HttpServerResponse.uint8Array(
              errPkt(parsedResult.failure.reason),
              { contentType: resultType, headers: noCache },
            );
          }
          const parsed = parsedResult.success;

          if (parsed.probe) {
            // git's empty-flush probe when the payload exceeds
            // http.postBuffer: reply empty 200 so it retries with the body.
            return HttpServerResponse.empty({
              status: 200,
              headers: { ...noCache, "content-type": resultType },
            });
          }

          const sideband = parsed.capabilities.has("side-band-64k");
          const wantReport =
            parsed.capabilities.has("report-status") ||
            parsed.capabilities.has("report-status-v2");

          const respond = (
            unpack: string,
            results: ReadonlyArray<{
              readonly ref: string;
              readonly ok: boolean;
              readonly reason?: string | undefined;
            }>,
          ) => {
            if (!wantReport) {
              return HttpServerResponse.empty({
                status: 200,
                headers: { ...noCache, "content-type": resultType },
              });
            }
            const lines: Array<Uint8Array> = [pktText(`unpack ${unpack}`)];
            for (const result of results) {
              lines.push(
                result.ok
                  ? pktText(`ok ${result.ref}`)
                  : pktText(`ng ${result.ref} ${result.reason ?? "failed"}`),
              );
            }
            lines.push(flushPkt);
            const report = concatBytes(lines);
            const bytes = sideband
              ? concatBytes([...sidebandFrames(1, report), flushPkt])
              : report;
            return HttpServerResponse.uint8Array(bytes, {
              contentType: resultType,
              headers: noCache,
            });
          };

          const allNg = (reason: string) =>
            parsed.commands.map((cmd) => ({
              ref: cmd.ref,
              ok: false,
              reason,
            }));

          if (meta.readOnly) {
            return respond("ok", allNg("repository is read-only"));
          }

          // One push at a time (DESIGN.md §2.1): wait ≤ 30 s for the permit.
          const permit = yield* Semaphore.take(pushSemaphore, 1).pipe(
            Effect.timeoutOption(PUSH_WAIT_TIMEOUT),
          );
          if (Option.isNone(permit)) {
            return wire503;
          }

          // Declared out here so the `ensuring` below (which runs outside
          // the generator) can drop the parked pack.
          let parkedKey: string | undefined;
          return yield* Effect.gen(function* () {
            const pushId = yield* ulid();
            yield* sql.run(
              `INSERT INTO pushes (push_id, started_at, state) VALUES (?, ?, 'staging')`,
              pushId,
              Date.now(),
            );
            const objects = storeFor(meta.repoId);
            const hasPack = parsed.packStart < body.length;

            let ingest: IngestResult | undefined;
            if (hasPack) {
              const packSlice = body.subarray(parsed.packStart);
              // Small packs parse straight out of memory. Larger ones are
              // parked in R2 first and read back through bounded windows, so
              // a push is never limited by the isolate's memory (DESIGN §3.6).
              const source = yield* packSlice.length <= MAX_PACK_BYTES
                ? Effect.succeed(bufferRandomAccess(packSlice))
                : Effect.gen(function* () {
                    const key = incomingKey(meta.repoId, pushId);
                    yield* bucket
                      .put(key, packSlice, {
                        contentLength: packSlice.length,
                      })
                      .pipe(
                        Effect.mapError(
                          (error) =>
                            new StoreError({
                              reason: `incoming pack put: ${error.message}`,
                            }),
                        ),
                      );
                    parkedKey = key;
                    return r2RandomAccess({
                      bucket,
                      key,
                      size: packSlice.length,
                    });
                  });
              const outcome = yield* Effect.result(
                ingestPackFrom(source, {
                  store: objects,
                  pushId,
                }),
              );
              if (Result.isFailure(outcome)) {
                // Surface the actual reason: a bare "internal storage error"
                // makes a failed push undiagnosable from the client side.
                const reason = outcome.failure.reason;
                yield* Effect.logError("push ingest failed", outcome.failure);
                return respond(reason, allNg("unpacker error"));
              }
              ingest = outcome.success;
            }

            // Full connectivity check (§3.6 step 5).
            const referenced = new Set<string>(ingest?.referenced ?? []);
            for (const parent of ingest?.referencedParents ?? []) {
              referenced.add(parent);
            }
            for (const cmd of parsed.commands) {
              if (cmd.newOid !== ZERO_OID) referenced.add(cmd.newOid);
            }
            const missing = yield* objects.missingObjects(
              Array.from(referenced),
              pushId,
            );
            if (missing.length > 0) {
              return respond(
                `missing objects (${missing.length})`,
                allNg("missing necessary objects"),
              );
            }

            const graph = yield* computeGraphRows(ingest?.commits ?? []);
            const results = yield* finalizeRefTxn({
              commands: parsed.commands,
              atomic: parsed.capabilities.has("atomic"),
              pushId,
              graph,
            });

            // Post-commit bookkeeping off the response path: staged-row GC
            // and, once enough loose bytes have accumulated, compaction into
            // an R2 pack (DESIGN.md §12.1).
            yield* state.waitUntil(
              upsertJob("gc", null).pipe(
                Effect.flatMap(() => armAlarmAt(Date.now() + STAGING_TTL_MS)),
                Effect.flatMap(() => shouldCompact(sql)),
                Effect.flatMap((due) =>
                  due
                    ? upsertJob("compact", null).pipe(
                        Effect.flatMap(() => armAlarmAt(Date.now() + 1_000)),
                      )
                    : Effect.void,
                ),
                // Re-cut the clone bundle for the new ref snapshot. Debounced
                // by the alarm itself: rapid-fire pushes coalesce into one
                // run because the job row is upserted, not queued.
                Effect.flatMap(() => upsertJob("bundle", null)),
                Effect.flatMap(() => armAlarmAt(Date.now() + 2_000)),
                Effect.ignore,
              ),
            );

            return respond("ok", results);
          }).pipe(
            Effect.ensuring(
              Effect.suspend(() =>
                parkedKey === undefined
                  ? Effect.void
                  : bucket.delete(parkedKey).pipe(Effect.ignore),
              ),
            ),
            Effect.ensuring(Semaphore.release(pushSemaphore, 1)),
          );
        });

      // ── alarm jobs ───────────────────────────────────────────────────────
      const runGcJob = Effect.gen(function* () {
        const cutoff = Date.now() - STAGING_TTL_MS;
        yield* sql.run(
          `DELETE FROM objects WHERE staged_push IN
             (SELECT push_id FROM pushes WHERE state = 'staging' AND started_at < ?)`,
          cutoff,
        );
        yield* sql.run(
          `DELETE FROM pushes WHERE state = 'staging' AND started_at < ?`,
          cutoff,
        );
        yield* sql.run(`DELETE FROM jobs WHERE kind = 'gc'`);
      });

      /**
       * Compaction (DESIGN.md §12.1): moves loose object bytes out of DO
       * SQLite into an immutable R2 pack, bounded per run and re-armed
       * while more remain.
       */
      const runCompactAlarm = Effect.gen(function* () {
        const meta = yield* requireMeta;
        const outcome = yield* runCompactJob({
          repoId: meta.repoId,
          sql,
          bucket,
        });
        if (outcome.more) {
          yield* armAlarmAt(Date.now() + 1_000);
          return;
        }
        yield* sql.run(`DELETE FROM jobs WHERE kind = 'compact'`);
      });

      /** The repo's current clone bundle, if one has been cut. */
      /**
       * Pushes the denormalised display fields to the Registry so listing
       * repos never has to wake this DO (DESIGN.md §15 bottleneck 7).
       * Best-effort: the DO remains the source of truth, and a failed
       * refresh only makes a listing momentarily stale.
       */
      const syncSummary = Effect.fn(function* (meta: RepoMetaData) {
        yield* registry
          .getByName(REGISTRY_DO_NAME)
          .updateSummary(meta.repoId, {
            defaultBranch: meta.defaultBranch,
            readOnly: meta.readOnly,
            status: meta.status,
          })
          .pipe(Effect.ignore);
      });

      /** Re-reads metadata and refreshes the Registry summary. */
      const refreshSummary: Effect.Effect<void, never, RuntimeContext> =
        readMeta.pipe(
          Effect.flatMap((meta) =>
            meta === undefined ? Effect.void : syncSummary(meta),
          ),
          Effect.ignore,
        );

      const readBundle: Effect.Effect<BundleInfo | undefined, StoreError> =
        getConfig("bundle").pipe(
          Effect.map((value) =>
            value === undefined ? undefined : (JSON.parse(value) as BundleInfo),
          ),
        );

      /**
       * Cuts a clone bundle for the current refs (DESIGN.md §12.2) so future
       * clones are served as bytes from R2 instead of a fresh closure walk.
       */
      const runBundleAlarm = Effect.gen(function* () {
        const meta = yield* requireMeta;
        const objects = storeFor(meta.repoId);
        const refRows = yield* sql.all<RefRow>(
          `SELECT name, oid FROM refs ORDER BY name`,
        );
        const shallowRoots = JSON.parse(
          (yield* getConfig("shallow_roots")) ?? "[]",
        ) as ReadonlyArray<string>;
        const closure = yield* computeClosure({ sql, objects })({
          wants: refRows.map((ref) => ref.oid),
          haves: [],
          clientShallow: [],
          repoShallow: shallowRoots,
        }).pipe(
          Effect.catchTag("ManifestTooLarge", (error) =>
            Effect.fail(new StoreError({ reason: `bundle: ${error._tag}` })),
          ),
        );
        const info = yield* runBundleJob({
          repoId: meta.repoId,
          refs: refRows.map((ref) => ({ name: ref.name, oid: ref.oid })),
          entries: closure.entries,
          packStream: (entries) => packStream(entries, objects),
          bucket,
        });
        if (info !== undefined) {
          yield* setConfig("bundle", JSON.stringify(info));
        }
        yield* sql.run(`DELETE FROM jobs WHERE kind = 'bundle'`);
      });

      const runImportAlarm = (job: JobRow) =>
        Effect.gen(function* () {
          const meta = yield* requireMeta;
          const detail = JSON.parse(job.detail ?? "{}") as {
            readonly source: ImportSource;
            readonly attempts?: number;
          };
          const attempts = detail.attempts ?? 0;
          const outcome = yield* Effect.result(
            runImport({ source: detail.source }).pipe(
              Effect.provide(FetchHttpClient.layer),
            ),
          );
          if (Result.isFailure(outcome)) {
            if (attempts + 1 >= 3) {
              yield* sql.run(
                `UPDATE jobs SET state = 'failed', detail = ?, updated_at = ? WHERE kind = 'import'`,
                JSON.stringify({ ...detail, error: outcome.failure.reason }),
                Date.now(),
              );
              // Give the empty repo back rather than wedging in 'importing'.
              yield* setConfig("status", "ready");
              yield* refreshSummary;
              yield* refreshSummary;
              return;
            }
            yield* sql.run(
              `UPDATE jobs SET detail = ?, updated_at = ? WHERE kind = 'import'`,
              JSON.stringify({ ...detail, attempts: attempts + 1 }),
              Date.now(),
            );
            yield* armAlarmAt(Date.now() + 15_000);
            return;
          }
          const result = outcome.success;
          const objects = storeFor(meta.repoId);
          const pushId = yield* ulid();
          let graph: Array<{
            oid: string;
            tree: string;
            gen: number;
            commitTime: number;
            parents: ReadonlyArray<string>;
          }> = [];
          if (result.pack !== undefined) {
            const ingest = yield* ingestPack(result.pack, {
              store: objects,
              pushId,
              allowMissingParents: true,
            }).pipe(
              Effect.mapError(
                (error) =>
                  new StoreError({
                    reason:
                      error._tag === "PackIngestError"
                        ? `import ingest: ${error.reason}`
                        : error.reason,
                  }),
              ),
            );
            // Connectivity: hard edges only — shallow imports may lack
            // parent commits (they become walk boundaries).
            const missing = yield* objects.missingObjects(
              [...ingest.referenced],
              pushId,
            );
            if (missing.length > 0) {
              return yield* new StoreError({
                reason: `import produced ${missing.length} dangling objects`,
              });
            }
            graph = yield* computeGraphRows(ingest.commits);
            // A depth-limited import leaves parents un-ingested: record the
            // boundary commits so upload-pack serves this repo as shallow
            // (walk bound + `shallow` lines — see handleUploadPack).
            const parentOids = Array.from(
              new Set(ingest.commits.flatMap((commit) => commit.parents)),
            );
            const missingParents = new Set(
              yield* objects.missingObjects(parentOids, pushId),
            );
            if (missingParents.size > 0) {
              const shallowRoots = ingest.commits
                .filter((commit) =>
                  commit.parents.some((parent) => missingParents.has(parent)),
                )
                .map((commit) => commit.oid);
              yield* setConfig("shallow_roots", JSON.stringify(shallowRoots));
            }
          }
          const commands: Array<RefCommand> = result.refs.map((ref) => ({
            oldOid: ZERO_OID,
            newOid: ref.oid,
            ref: ref.name,
          }));
          yield* finalizeRefTxn({
            commands,
            atomic: false,
            unconditional: true,
            pushId,
            graph,
          });
          if (result.defaultBranch !== null) {
            yield* setConfig("default_branch", result.defaultBranch);
          }
          yield* setConfig("status", "ready");
          yield* refreshSummary;
          yield* sql.run(`DELETE FROM jobs WHERE kind = 'import'`);
        });

      const runForkAlarm = (job: JobRow) =>
        Effect.gen(function* () {
          const detail = JSON.parse(job.detail ?? "{}") as {
            readonly parentRepoId: string;
            readonly attempts?: number;
          };
          const parentStub = selfNamespace.getByName(
            detail.parentRepoId,
          ) as unknown as RepoStub;
          const applied = yield* Effect.result(
            runForkJob({
              sql,
              snapshot: parentStub.snapshotRows(),
            }),
          );
          if (Result.isFailure(applied)) {
            const attempts = (detail.attempts ?? 0) + 1;
            if (attempts >= 3) {
              yield* sql.run(
                `UPDATE jobs SET state = 'failed', detail = ?, updated_at = ? WHERE kind = 'fork'`,
                JSON.stringify({ ...detail, error: applied.failure.reason }),
                Date.now(),
              );
              yield* setConfig("status", "ready");
              yield* refreshSummary;
              yield* refreshSummary;
              return;
            }
            yield* sql.run(
              `UPDATE jobs SET detail = ?, updated_at = ? WHERE kind = 'fork'`,
              JSON.stringify({ ...detail, attempts }),
              Date.now(),
            );
            yield* armAlarmAt(Date.now() + 15_000);
            return;
          }
          yield* setConfig("status", "ready");
          yield* refreshSummary;
          yield* sql.run(`DELETE FROM jobs WHERE kind = 'fork'`);
        });

      /** Returns true when storage was wiped (stop touching SQLite). */
      const runPurgeAlarm = Effect.gen(function* () {
        const meta = yield* readMeta;
        if (meta === undefined) return true;
        const registryStub = registry.getByName(REGISTRY_DO_NAME);
        const outcome = yield* runPurgeJob({
          repoId: meta.repoId,
          bucket,
          // RuntimeContext is genuinely satisfied here (we run inside the
          // DO); discharge the coloring so the purge job's deps stay R=never.
          forkCount: registryStub.bumpForkCount(meta.repoId, 0).pipe(
            Effect.mapError(
              (error) => new StoreError({ reason: String(error) }),
            ),
            Effect.provide(RuntimeContext.phantom),
          ),
          deleteAllStorage: state.storage.deleteAll().pipe(
            Effect.mapError(
              (error) => new StoreError({ reason: String(error) }),
            ),
            Effect.provide(RuntimeContext.phantom),
          ),
          removeRegistryRow: registryStub.removeRow(meta.repoId).pipe(
            Effect.mapError(
              (error) => new StoreError({ reason: String(error) }),
            ),
            Effect.provide(RuntimeContext.phantom),
          ),
        });
        if (outcome._tag === "continue") {
          yield* armAlarmAt(Date.now() + (outcome.forkPinned ? 60_000 : 5_000));
          return false;
        }
        yield* state.storage.deleteAlarm();
        return true;
      });

      // ── the shape ────────────────────────────────────────────────────────
      const shape: GitRepoShape = {
        initRepo: (input) => bootstrap(input, "ready"),

        startImport: Effect.fn(function* (input: StartImportInput) {
          const result = yield* bootstrap(input, "importing");
          yield* upsertJob("import", JSON.stringify({ source: input.source }));
          yield* armAlarmAt(Date.now());
          return result;
        }),

        startFork: Effect.fn(function* (input: StartForkInput) {
          const result = yield* bootstrap(input, "forking");
          yield* upsertJob(
            "fork",
            JSON.stringify({ parentRepoId: input.parentRepoId }),
          );
          yield* armAlarmAt(Date.now());
          return result;
        }),

        startCompact: Effect.fn(function* (auth: CallerAuth) {
          yield* requireMeta;
          yield* authorize(auth, "admin");
          yield* upsertJob("compact", null);
          yield* armAlarmAt(Date.now());
        }),

        startPurge: Effect.fn(function* (auth: CallerAuth) {
          yield* requireMeta;
          yield* authorize(auth, "admin");
          yield* setConfig("status", "deleting");
          yield* refreshSummary;
          yield* upsertJob("purge", null);
          yield* armAlarmAt(Date.now());
        }),

        verifyToken: (tokenHash, required) =>
          verifyTokenHash(tokenHash, required),

        getRepoMeta: Effect.fn(function* (auth: CallerAuth) {
          const meta = yield* requireMeta;
          yield* authorize(auth, "read");
          return meta;
        }),

        updateRepoMeta: Effect.fn(function* (
          auth: CallerAuth,
          patch: RepoMetaPatch,
        ) {
          const meta = yield* requireMeta;
          yield* authorize(auth, "admin");
          if (patch.defaultBranch !== undefined) {
            const ref = yield* sql.first<RefRow>(
              `SELECT name, oid FROM refs WHERE name = ?`,
              `refs/heads/${patch.defaultBranch}`,
            );
            if (ref === undefined) {
              return yield* new RefNotFound({
                ref: `refs/heads/${patch.defaultBranch}`,
              });
            }
            yield* setConfig("default_branch", patch.defaultBranch);
          }
          if (patch.description !== undefined) {
            if (patch.description === null) {
              yield* sql.run(`DELETE FROM config WHERE key = 'description'`);
            } else {
              yield* setConfig("description", patch.description);
            }
          }
          if (patch.readOnly !== undefined) {
            yield* setConfig("read_only", patch.readOnly ? "1" : "0");
          }
          const updated = yield* readMeta;
          const result = updated ?? meta;
          // Keep the Registry's denormalised copy in step (listing reads it).
          yield* syncSummary(result);
          return result;
        }),

        createToken: Effect.fn(function* (
          auth: CallerAuth,
          input: {
            readonly name: string;
            readonly scope: TokenScope;
            readonly ttlSeconds?: number | undefined;
          },
        ) {
          yield* requireMeta;
          yield* authorize(auth, "admin");
          return yield* mintRepoToken(input);
        }),

        listTokens: Effect.fn(function* (auth: CallerAuth) {
          yield* requireMeta;
          yield* authorize(auth, "admin");
          const rows = yield* sql.all<TokenRow>(
            `SELECT * FROM tokens ORDER BY created_at`,
          );
          return rows
            .filter((row) => isTokenScope(row.scope))
            .map(
              (row): TokenData => ({
                id: row.id,
                name: row.name,
                scope: row.scope as TokenScope,
                createdAt: row.created_at,
                expiresAt: row.expires_at,
                lastUsedAt: row.last_used_at,
              }),
            );
        }),

        revokeToken: Effect.fn(function* (auth: CallerAuth, id: string) {
          yield* requireMeta;
          yield* authorize(auth, "admin");
          const row = yield* sql.first<TokenRow>(
            `SELECT * FROM tokens WHERE id = ?`,
            id,
          );
          if (row === undefined) {
            return yield* new TokenNotFound({ id });
          }
          yield* sql.run(`DELETE FROM tokens WHERE id = ?`, id);
        }),

        listRefs: Effect.fn(function* (
          auth: CallerAuth,
          prefix?: string | undefined,
        ) {
          const meta = yield* requireMeta;
          yield* authorize(auth, "read");
          const refs = yield* listAllRefs(meta.repoId, prefix);
          const headRef = `refs/heads/${meta.defaultBranch}`;
          const headExists = yield* sql.first<RefRow>(
            `SELECT name, oid FROM refs WHERE name = ?`,
            headRef,
          );
          return {
            head: headExists === undefined ? null : headRef,
            refs,
          } satisfies RefsPage;
        }),

        getRef: Effect.fn(function* (auth: CallerAuth, name: string) {
          const meta = yield* requireMeta;
          yield* authorize(auth, "read");
          const row = yield* sql.first<RefRow>(
            `SELECT name, oid FROM refs WHERE name = ?`,
            name,
          );
          if (row === undefined) {
            return yield* new RefNotFound({ ref: name });
          }
          const peeled = name.startsWith("refs/tags/")
            ? yield* peelOid(meta.repoId, row.oid)
            : undefined;
          return peeled === undefined
            ? { name: row.name, oid: row.oid }
            : ({ name: row.name, oid: row.oid, peeled } satisfies RefData);
        }),

        updateRef: Effect.fn(function* (
          auth: CallerAuth,
          input: UpdateRefInput,
        ) {
          const meta = yield* requireMeta;
          yield* authorize(auth, "write");
          if (meta.readOnly) {
            return yield* new ReadOnlyRepo();
          }
          const objects = storeFor(meta.repoId);
          const exists = yield* objects.has(input.newOid);
          if (!exists) {
            return yield* new ObjectNotFound({ oid: input.newOid });
          }
          yield* sql.transactionSync<void, RefConflict>((raw, rollback) => {
            const rows = raw
              .exec<RefRow>(
                `SELECT name, oid FROM refs WHERE name = ?`,
                input.name,
              )
              .toArray();
            const current = rows.length > 0 ? rows[0]!.oid : null;
            if (input.expectedOid !== undefined) {
              const expected = input.expectedOid; // string | null
              if (current !== expected) {
                rollback(
                  new RefConflict({
                    ref: input.name,
                    currentOid: current === null ? null : asOid(current),
                  }),
                );
              }
            }
            raw.exec(
              `INSERT INTO refs (name, oid) VALUES (?, ?)
               ON CONFLICT (name) DO UPDATE SET oid = excluded.oid`,
              input.name,
              input.newOid,
            );
          });
          return { name: input.name, oid: input.newOid } satisfies RefData;
        }),

        removeRef: Effect.fn(function* (
          auth: CallerAuth,
          input: RemoveRefInput,
        ) {
          const meta = yield* requireMeta;
          yield* authorize(auth, "write");
          if (meta.readOnly) {
            return yield* new ReadOnlyRepo();
          }
          yield* sql.transactionSync<void, RefConflict | RefNotFound>(
            (raw, rollback) => {
              const rows = raw
                .exec<RefRow>(
                  `SELECT name, oid FROM refs WHERE name = ?`,
                  input.name,
                )
                .toArray();
              if (rows.length === 0) {
                rollback(new RefNotFound({ ref: input.name }));
              }
              const current = rows[0]!.oid;
              if (
                input.expectedOid !== undefined &&
                current !== input.expectedOid
              ) {
                rollback(
                  new RefConflict({
                    ref: input.name,
                    currentOid: asOid(current),
                  }),
                );
              }
              raw.exec(`DELETE FROM refs WHERE name = ?`, input.name);
            },
          );
        }),

        readObject: Effect.fn(function* (
          auth: CallerAuth,
          input: ReadObjectInput,
        ) {
          const meta = yield* requireMeta;
          yield* authorize(auth, "read");
          const objects = storeFor(meta.repoId);
          const objectMeta = yield* objects.getMeta(input.oid);
          if (objectMeta === undefined) {
            return yield* new ObjectNotFound({ oid: input.oid });
          }
          const actual = objectTypeName(objectMeta.type);
          if (input.expect !== undefined && actual !== input.expect) {
            return yield* new WrongObjectType({
              oid: input.oid,
              expected: input.expect,
              actual,
            });
          }
          const content = yield* objects.readContent(input.oid);
          return {
            oid: input.oid,
            type: actual,
            size: objectMeta.size,
            content,
          } satisfies ObjectData;
        }),

        readCommitLog: Effect.fn(function* (
          auth: CallerAuth,
          input: CommitLogInput,
        ) {
          const meta = yield* requireMeta;
          yield* authorize(auth, "read");
          const objects = storeFor(meta.repoId);
          const limit = Math.max(1, Math.min(input.limit ?? 20, 100));

          // Resolve the starting commit.
          const start = yield* Effect.gen(function* () {
            const refName =
              input.ref === undefined
                ? `refs/heads/${meta.defaultBranch}`
                : input.ref;
            if (isOid(refName)) return refName;
            const candidates = refName.startsWith("refs/")
              ? [refName]
              : [`refs/heads/${refName}`, `refs/tags/${refName}`];
            for (const candidate of candidates) {
              const row = yield* sql.first<RefRow>(
                `SELECT name, oid FROM refs WHERE name = ?`,
                candidate,
              );
              if (row !== undefined) return row.oid;
            }
            return yield* new RefNotFound({ ref: refName });
          });

          // Commit-time-ordered walk (v1: recomputed from the start each
          // page; the cursor is the last emitted oid).
          const frontier: Array<{ oid: string; time: number }> = [];
          const visited = new Set<string>();
          const items: Array<CommitData> = [];
          let skipping = input.cursor !== undefined;
          let hasMore = false;

          const pushFrontier = Effect.fn(function* (oid: string) {
            if (visited.has(oid)) return;
            visited.add(oid);
            const row = yield* sql.first<{ commit_time: number }>(
              `SELECT commit_time FROM commits WHERE oid = ?`,
              oid,
            );
            if (row !== undefined) {
              frontier.push({ oid, time: row.commit_time });
            }
          });
          // The start may be a tag — peel to a commit.
          const startMeta = yield* objects.getMeta(start);
          if (startMeta === undefined) {
            return yield* new RefNotFound({ ref: input.ref ?? "HEAD" });
          }
          const startCommit =
            startMeta.type === ObjectType.tag
              ? yield* peelOid(meta.repoId, start).pipe(
                  Effect.map((peeled) => peeled ?? start),
                )
              : start;
          yield* pushFrontier(startCommit);

          while (frontier.length > 0) {
            // pop max commit_time
            let best = 0;
            for (let i = 1; i < frontier.length; i++) {
              if (frontier[i]!.time > frontier[best]!.time) best = i;
            }
            const [next] = frontier.splice(best, 1);
            const oid = next!.oid;
            const parents = yield* sql.all<{ parent: string; ord: number }>(
              `SELECT parent, ord FROM commit_parents WHERE oid = ? ORDER BY ord`,
              oid,
            );
            for (const parent of parents) {
              yield* pushFrontier(parent.parent);
            }
            if (skipping) {
              if (oid === input.cursor) skipping = false;
              continue;
            }
            if (items.length >= limit) {
              hasMore = true;
              break;
            }
            const content = yield* objects.readContent(oid);
            const parsed = yield* parseCommit(content).pipe(
              Effect.mapError(
                (error) => new StoreError({ reason: error.reason }),
              ),
            );
            items.push({
              oid,
              tree: parsed.tree,
              parents: parsed.parents,
              author: {
                name: parsed.author.name,
                email: parsed.author.email,
                date: parsed.author.when,
                tz: parsed.author.tz,
              },
              committer: {
                name: parsed.committer.name,
                email: parsed.committer.email,
                date: parsed.committer.when,
                tz: parsed.committer.tz,
              },
              message: parsed.message,
            });
          }

          return {
            items,
            nextCursor: hasMore ? items[items.length - 1]!.oid : null,
            hasMore,
          } satisfies CommitLogPage;
        }),

        readFileAtPath: Effect.fn(function* (
          auth: CallerAuth,
          input: ReadFileInput,
        ) {
          const meta = yield* requireMeta;
          yield* authorize(auth, "read");
          const objects = storeFor(meta.repoId);

          const startOid = yield* Effect.gen(function* () {
            const refName =
              input.ref === undefined
                ? `refs/heads/${meta.defaultBranch}`
                : input.ref;
            if (isOid(refName)) return refName;
            const candidates = refName.startsWith("refs/")
              ? [refName]
              : [`refs/heads/${refName}`, `refs/tags/${refName}`];
            for (const candidate of candidates) {
              const row = yield* sql.first<RefRow>(
                `SELECT name, oid FROM refs WHERE name = ?`,
                candidate,
              );
              if (row !== undefined) return row.oid;
            }
            return yield* new RefNotFound({ ref: refName });
          });

          // Resolve start → commit → root tree (peel tags on the way).
          const rootTree = yield* Effect.gen(function* () {
            let current = startOid;
            for (let hops = 0; hops < 16; hops++) {
              const objectMeta = yield* objects.getMeta(current);
              if (objectMeta === undefined) {
                return yield* new ObjectNotFound({ oid: current });
              }
              if (objectMeta.type === ObjectType.tree) return current;
              const content = yield* objects.readContent(current);
              if (objectMeta.type === ObjectType.commit) {
                const parsed = yield* parseCommit(content).pipe(
                  Effect.mapError(
                    (error) => new StoreError({ reason: error.reason }),
                  ),
                );
                return parsed.tree;
              }
              if (objectMeta.type === ObjectType.tag) {
                const parsed = yield* parseTag(content).pipe(
                  Effect.mapError(
                    (error) => new StoreError({ reason: error.reason }),
                  ),
                );
                current = parsed.object;
                continue;
              }
              return yield* new ObjectNotFound({ oid: current });
            }
            return yield* new ObjectNotFound({ oid: current });
          });

          const segments = input.path.split("/").filter(Boolean);
          if (segments.length === 0) {
            return yield* new ObjectNotFound({ oid: rootTree });
          }
          let treeOid = rootTree;
          for (let i = 0; i < segments.length; i++) {
            const content = yield* objects.readContent(treeOid);
            const entries = yield* parseTree(content).pipe(
              Effect.mapError(
                (error) => new StoreError({ reason: error.reason }),
              ),
            );
            const entry = entries.find((e) => e.name === segments[i]);
            if (entry === undefined) {
              return yield* new ObjectNotFound({ oid: `${input.path}` });
            }
            const kind = treeEntryKind(entry.mode);
            if (i === segments.length - 1) {
              if (kind !== "blob") {
                return yield* new ObjectNotFound({ oid: input.path });
              }
              const blobMeta = yield* objects.getMeta(entry.oid);
              if (blobMeta === undefined) {
                return yield* new ObjectNotFound({ oid: entry.oid });
              }
              const blob = yield* objects.readContent(entry.oid);
              return {
                oid: entry.oid,
                mode: entry.mode,
                size: blobMeta.size,
                content: blob,
              } satisfies FileData;
            }
            if (kind !== "tree") {
              return yield* new ObjectNotFound({ oid: input.path });
            }
            treeOid = entry.oid;
          }
          // unreachable — the loop returns or fails
          return yield* new ObjectNotFound({ oid: input.path });
        }),

        snapshotRows: () => snapshotStream(sql),

        fetch: Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const path = parseWirePath(request.url);
          if (path === undefined) {
            return HttpServerResponse.text("not found", { status: 404 });
          }
          const meta = yield* readMeta;
          if (meta === undefined) {
            return HttpServerResponse.text("repository not found", {
              status: 404,
            });
          }
          // Stale-cache fail-safe (DESIGN.md §2.1): this DO only answers
          // for its own owner/name.
          if (path.owner !== meta.owner || path.repo !== meta.name) {
            return HttpServerResponse.text("repository not found", {
              status: 404,
            });
          }
          if (meta.status !== "ready") {
            return wire503;
          }
          if (path.endpoint === "info/refs" && request.method === "GET") {
            return yield* handleInfoRefs(request, path.service, meta);
          }
          if (
            path.endpoint === "git-upload-pack" &&
            request.method === "POST"
          ) {
            return yield* handleUploadPack(request, meta);
          }
          if (
            path.endpoint === "git-receive-pack" &&
            request.method === "POST"
          ) {
            return yield* handleReceivePack(request, meta);
          }
          return HttpServerResponse.text("not found", { status: 404 });
        }).pipe(
          Effect.catchTag("StoreError", (error) =>
            Effect.as(
              Effect.logError("git wire: storage failure", error),
              HttpServerResponse.text("internal error", { status: 500 }),
            ),
          ),
          Effect.catchTag("PackIngestError", (error) =>
            Effect.succeed(
              HttpServerResponse.uint8Array(errPkt(error.reason), {
                status: 200,
                headers: noCache,
              }),
            ),
          ),
        ),

        alarm: () =>
          Effect.gen(function* () {
            const jobs = yield* sql.all<JobRow>(
              `SELECT * FROM jobs WHERE state = 'running'`,
            );
            // `purge` runs FIRST and every job is individually isolated: a
            // job that keeps crashing must never starve the others. (It
            // did: a fork job dying on every alarm blocked the purge job
            // behind it forever, wedging the repo in `status: deleting`
            // and reserving its name.)
            const order = (kind: string) =>
              kind === "purge" ? 0 : kind === "gc" ? 2 : 1;
            const ordered = [...jobs].sort(
              (a, b) => order(a.kind) - order(b.kind),
            );
            for (const job of ordered) {
              const isolated = Effect.gen(function* () {
                switch (job.kind) {
                  case "purge": {
                    const wiped = yield* runPurgeAlarm;
                    return wiped; // storage is gone — stop the whole alarm
                  }
                  case "import":
                    yield* runImportAlarm(job);
                    return false;
                  case "fork":
                    yield* runForkAlarm(job);
                    return false;
                  case "gc":
                    yield* runGcJob;
                    return false;
                  case "compact":
                    yield* runCompactAlarm;
                    return false;
                  case "bundle":
                    yield* runBundleAlarm;
                    return false;
                  default:
                    yield* sql.run(`DELETE FROM jobs WHERE kind = ?`, job.kind);
                    return false;
                }
              }).pipe(
                Effect.catchCause((cause) =>
                  Effect.as(
                    Effect.logError(
                      `repo alarm job '${job.kind}' failed`,
                      cause,
                    ),
                    false,
                  ),
                ),
              );
              if (yield* isolated) return;
            }
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.gen(function* () {
                yield* Effect.logError("repo alarm failed", cause);
                // Best-effort retry — never let the alarm defect.
                yield* armAlarmAt(Date.now() + 30_000).pipe(Effect.ignore);
              }),
            ),
            Effect.asVoid,
          ),
      };

      return shape;
    });
  }),
);

export default GitRepoLive;
