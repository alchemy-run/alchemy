/**
 * The pack hasher (DESIGN §22.7): the CPU-heavy half of push ingest —
 * inflating and hashing entries, applying in-buffer deltas — as a service
 * the receive-pack pipeline calls per spilled part, so the repo's Durable
 * Object only receives bytes and stages rows.
 *
 * Two layers:
 *
 * - {@link HasherInline} runs the scan in the calling isolate — the
 *   reference assembly. On Cloudflare Workers a service-binding subrequest
 *   executes on the caller's own thread (measured, DESIGN §22.10), so
 *   fanning out buys no CPU there; inline avoids the copies and framing.
 * - {@link HasherSelf} posts each part to the Worker's own
 *   `/_alchemy/git/hash` route through a `Cloudflare.Workers.Self` service
 *   binding: the same work in another invocation of the same script. Kept
 *   for runtimes where such calls do run in parallel, and as the shape a
 *   remote hasher (a Container running native `index-pack`, a multi-core
 *   host behind a cross-zone URL) would take.
 *
 * The wire protocol is binary both ways (parts are megabytes; JSON would
 * base64 them): request body = the raw bytes, coordinates in the query;
 * response = `u32 jsonLength | json | blob area`, where the JSON's entries
 * reference their content/zdata as `[offset, length]` into the blob area.
 */
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Fiber from "effect/Fiber";
import { WorkerEnvironment } from "../Cloudflare/Workers/Worker.ts";
import { RuntimeContext } from "../RuntimeContext.ts";
import { ADMIN_TOKEN_CONFIG_KEY } from "./Auth.ts";
import {
  BlobStore,
  type BlobStoreShape,
  type UploadedPart,
} from "./BlobStore.ts";
import type { Oid, ObjectType } from "./git/ObjectCodec.ts";
import {
  type EntryBounds,
  hashBounds,
  scanPart,
  type ScanResult,
} from "./git/PartialScan.ts";
import { ObjectTooLargeError, PackFormatError } from "./git/PackParser.ts";

export class HashError extends Schema.TaggedError<HashError>()("HashError", {
  reason: Schema.String,
}) {}

export interface HashPartOptions {
  /** Pack-relative offset of `payload[skip]`. */
  readonly base: number;
  readonly remaining: number;
  readonly maxObjectSize: number;
  /** The payload is a raw chunk: find the first boundary first (DESIGN §22.9). */
  readonly resync?: boolean | undefined;
  /**
   * Scanning starts at `payload[skip]`; the bytes before it (the request's
   * command section and the pack header, in a body-aligned first part) are
   * spilled but not scanned.
   */
  readonly skip?: number | undefined;
  /**
   * Write the WHOLE payload as this part of a multipart upload while
   * scanning it (DESIGN §22.10): the hasher isolate is the spill's writer,
   * so the receiver sends each byte out once.
   */
  readonly spill?:
    | {
        readonly key: string;
        readonly uploadId: string;
        readonly partNumber: number;
      }
    | undefined;
}

/**
 * A scan plus, when a spill was requested, the uploaded part's identity —
 * DEFERRED: the scan is available as soon as the hasher has it, while the
 * part's upload to blob storage may still be in flight (DESIGN §22.9).
 */
export interface HashPartResult extends ScanResult {
  readonly part?: Effect.Effect<UploadedPart, HashError> | undefined;
}

export interface HasherShape {
  readonly hashPart: (
    payload: Uint8Array,
    options: HashPartOptions,
  ) => Effect.Effect<
    HashPartResult,
    HashError | PackFormatError | ObjectTooLargeError
  >;
  /**
   * The parallel half (DESIGN §22.8): hash entries whose spans the caller
   * already found with `scanBounds`. Parts hashed this way have no chain
   * between them.
   */
  readonly hashBoundsPart: (
    payload: Uint8Array,
    bounds: ReadonlyArray<EntryBounds>,
    options: { readonly base: number; readonly maxObjectSize: number },
  ) => Effect.Effect<
    ScanResult,
    HashError | PackFormatError | ObjectTooLargeError
  >;
}

export class Hasher extends Context.Service<Hasher, HasherShape>()(
  "alchemy/Git/Hasher",
) {}

/** The in-process hasher: scans here; a requested spill part goes to `blobs`. */
export const makeInlineHasher = (blobs: BlobStoreShape): HasherShape => ({
  hashPart: (payload, options) =>
    Effect.gen(function* () {
      const spill = options.spill;
      // Detached: the caller's fiber ends with the scan; the part is joined
      // later, before the multipart upload is completed.
      const upload =
        spill === undefined
          ? undefined
          : yield* Effect.forkDetach(
              blobs
                .uploadPart(
                  spill.key,
                  spill.uploadId,
                  spill.partNumber,
                  payload,
                )
                .pipe(
                  Effect.mapError(
                    (error) =>
                      new HashError({
                        reason: `spill part ${spill.partNumber}: ${error.reason}`,
                      }),
                  ),
                  Effect.provide(RuntimeContext.phantom),
                ),
            );
      const skip = options.skip ?? 0;
      const scan = yield* scanPart(
        skip === 0 ? payload : payload.subarray(skip),
        options,
      );
      return {
        ...scan,
        part: upload === undefined ? undefined : Fiber.join(upload),
      };
    }),
  hashBoundsPart: (payload, bounds, options) =>
    hashBounds(payload, bounds, options),
});

/** Runs the scan in-process (tests, or a deployment without a self binding). */
export const HasherInline: Layer.Layer<Hasher, never, BlobStore> = Layer.effect(
  Hasher,
  Effect.map(BlobStore, makeInlineHasher),
);

/**
 * Request framing for the bounds mode: `u32 jsonLength | json(bounds) |
 * bytes`.
 */
export const encodeBoundsRequest = (
  payload: Uint8Array,
  bounds: ReadonlyArray<EntryBounds>,
): Uint8Array => {
  const json = new TextEncoder().encode(JSON.stringify(bounds));
  const out = new Uint8Array(4 + json.length + payload.length);
  new DataView(out.buffer).setUint32(0, json.length);
  out.set(json, 4);
  out.set(payload, 4 + json.length);
  return out;
};

export const decodeBoundsRequest = (
  body: Uint8Array,
): {
  readonly bounds: ReadonlyArray<EntryBounds>;
  readonly payload: Uint8Array;
} => {
  const jsonLength = new DataView(body.buffer, body.byteOffset).getUint32(0);
  const bounds = JSON.parse(
    new TextDecoder().decode(body.subarray(4, 4 + jsonLength)),
  ) as ReadonlyArray<EntryBounds>;
  return { bounds, payload: body.subarray(4 + jsonLength) };
};

/** The internal route the self-binding layer posts to. */
export const HASH_ROUTE = "/_alchemy/git/hash";
/** The `env` name of the self service binding (`GIT_WORKER_OPTIONS`). */
export const HASHER_BINDING = "GIT_SELF";

// ── protocol ────────────────────────────────────────────────────────────────

interface WireEntry {
  readonly o: string; // oid
  readonly t: number; // type
  readonly h: number; // header offset
  readonly s: number; // size
  readonly d: number; // dataOffset
  readonly n: number; // span
  readonly z?: [number, number]; // zdata [offset, length] in the blob area
  readonly c?: [number, number]; // content [offset, length]
}
interface WireResult {
  readonly firstOffset: number;
  readonly entries: ReadonlyArray<WireEntry>;
  readonly unresolved: ScanResult["unresolved"];
  readonly consumedTo: number;
  readonly count: number;
}

export const encodeScanResult = (result: ScanResult): Uint8Array => {
  const blobs: Array<Uint8Array> = [];
  let at = 0;
  const put = (bytes: Uint8Array): [number, number] => {
    blobs.push(bytes);
    const ref: [number, number] = [at, bytes.length];
    at += bytes.length;
    return ref;
  };
  const wire: WireResult = {
    firstOffset: result.firstOffset,
    entries: result.entries.map((e) => ({
      o: e.oid,
      t: e.type,
      h: e.offset,
      s: e.size,
      d: e.dataOffset,
      n: e.span,
      ...(e.zdata === undefined ? {} : { z: put(e.zdata) }),
      ...(e.content === undefined ? {} : { c: put(e.content) }),
    })),
    unresolved: result.unresolved,
    consumedTo: result.consumedTo,
    count: result.count,
  };
  const json = new TextEncoder().encode(JSON.stringify(wire));
  const out = new Uint8Array(4 + json.length + at);
  new DataView(out.buffer).setUint32(0, json.length);
  out.set(json, 4);
  let cursor = 4 + json.length;
  for (const b of blobs) {
    out.set(b, cursor);
    cursor += b.length;
  }
  return out;
};

export const decodeScanResult = (bytes: Uint8Array): ScanResult => {
  const jsonLength = new DataView(bytes.buffer, bytes.byteOffset).getUint32(0);
  const wire = JSON.parse(
    new TextDecoder().decode(bytes.subarray(4, 4 + jsonLength)),
  ) as WireResult;
  const blobs = bytes.subarray(4 + jsonLength);
  const slice = (ref: [number, number] | undefined) =>
    ref === undefined ? undefined : blobs.subarray(ref[0], ref[0] + ref[1]);
  return {
    firstOffset: wire.firstOffset,
    entries: wire.entries.map((e) => ({
      oid: e.o as Oid,
      type: e.t as ObjectType,
      offset: e.h,
      size: e.s,
      dataOffset: e.d,
      span: e.n,
      zdata: slice(e.z),
      content: slice(e.c),
    })),
    unresolved: wire.unresolved,
    consumedTo: wire.consumedTo,
    count: wire.count,
  };
};

/**
 * Response framing of the hash route: `u32 len | frame` repeated — the
 * scan first, then (spill only) the uploaded part as JSON once its upload
 * has finished. The client acts on the scan without waiting for the part.
 */
export const frame = (bytes: Uint8Array): Uint8Array => {
  const out = new Uint8Array(4 + bytes.length);
  new DataView(out.buffer).setUint32(0, bytes.length);
  out.set(bytes, 4);
  return out;
};

/** Reads length-prefixed frames off a response body, one at a time. */
export const makeFrameReader = (body: ReadableStream<Uint8Array>) => {
  const reader = body.getReader();
  const pending: Array<Uint8Array> = [];
  let pendingBytes = 0;
  const take = (n: number): Uint8Array => {
    const out = new Uint8Array(n);
    let written = 0;
    while (written < n) {
      const head = pending[0]!;
      const use = Math.min(head.length, n - written);
      out.set(head.subarray(0, use), written);
      written += use;
      if (use === head.length) pending.shift();
      else pending[0] = head.subarray(use);
    }
    pendingBytes -= n;
    return out;
  };
  const peekLength = (): number | undefined => {
    if (pendingBytes < 4) return undefined;
    const head = take(4);
    const len = new DataView(head.buffer).getUint32(0);
    pending.unshift(head);
    pendingBytes += 4;
    return len;
  };
  return (): Effect.Effect<Uint8Array | undefined, HashError> =>
    Effect.tryPromise({
      try: async () => {
        while (true) {
          const len = peekLength();
          if (len !== undefined && pendingBytes >= 4 + len) {
            take(4);
            return take(len);
          }
          const { value, done } = await reader.read();
          if (done) return undefined;
          pending.push(value);
          pendingBytes += value.length;
        }
      },
      catch: (error) =>
        new HashError({ reason: `hash part body: ${String(error)}` }),
    });
};

// ── self-binding layer ──────────────────────────────────────────────────────

interface SelfFetcher {
  readonly fetch: (input: string, init?: RequestInit) => Promise<Response>;
}

/**
 * Posts each part to the Worker's own hash route through the self service
 * binding (`GIT_WORKER_OPTIONS` declares it as `GIT_SELF`). The internal
 * call authenticates with the service's admin key, read from the same
 * config the Worker uses. Falls back to {@link HasherInline} when the
 * binding is absent from the environment.
 */
export const HasherSelf: Layer.Layer<
  Hasher,
  never,
  WorkerEnvironment | BlobStore
> = Layer.effect(
  Hasher,
  Effect.gen(function* () {
    const env = yield* WorkerEnvironment;
    const blobs = yield* BlobStore;
    const fetcher = (env as Record<string, unknown>)[HASHER_BINDING] as
      | SelfFetcher
      | undefined;
    const adminKey = yield* Config.redacted(ADMIN_TOKEN_CONFIG_KEY).pipe(
      Effect.map(Redacted.value),
      Effect.orElseSucceed(() => undefined),
    );
    if (fetcher === undefined || adminKey === undefined) {
      return makeInlineHasher(blobs);
    }
    const send = (url: string, body: Uint8Array) =>
      Effect.gen(function* () {
        const response = yield* Effect.tryPromise({
          try: () =>
            fetcher.fetch(url, {
              method: "POST",
              headers: {
                "content-type": "application/octet-stream",
                authorization: `Bearer ${adminKey}`,
              },
              body: body as unknown as BodyInit,
            }),
          catch: (error) =>
            new HashError({ reason: `hash part fetch: ${String(error)}` }),
        });
        if (response.status !== 200 || response.body === null) {
          const text = yield* Effect.tryPromise({
            try: () => response.text(),
            catch: () => new HashError({ reason: "hash part: unreadable" }),
          });
          return yield* new HashError({
            reason: `hash part: status ${response.status}: ${text.slice(0, 200)}`,
          });
        }
        return makeFrameReader(response.body);
      });
    const post = (url: string, body: Uint8Array) =>
      Effect.gen(function* () {
        const next = yield* send(url, body);
        const first = yield* next();
        if (first === undefined) {
          return yield* new HashError({ reason: "hash part: empty response" });
        }
        return decodeScanResult(first);
      });
    return {
      hashPart: (payload, opts) =>
        Effect.gen(function* () {
          const spill =
            opts.spill === undefined
              ? ""
              : `&key=${encodeURIComponent(opts.spill.key)}&uploadId=${encodeURIComponent(opts.spill.uploadId)}&part=${opts.spill.partNumber}`;
          const next = yield* send(
            `https://self${HASH_ROUTE}?base=${opts.base}&remaining=${opts.remaining}&max=${opts.maxObjectSize}${opts.resync ? "&resync=1" : ""}${opts.skip ? `&skip=${opts.skip}` : ""}${spill}`,
            payload,
          );
          const first = yield* next();
          if (first === undefined) {
            return yield* new HashError({
              reason: "hash part: empty response",
            });
          }
          const scan = decodeScanResult(first);
          if (opts.spill === undefined) return scan;
          // The part frame arrives once the hasher's upload has finished.
          const part = next().pipe(
            Effect.flatMap((bytes) =>
              bytes === undefined
                ? Effect.fail(
                    new HashError({ reason: "hash part: no part frame" }),
                  )
                : Effect.succeed(
                    JSON.parse(new TextDecoder().decode(bytes)) as UploadedPart,
                  ),
            ),
          );
          return { ...scan, part };
        }),
      hashBoundsPart: (payload, bounds, opts) =>
        post(
          `https://self${HASH_ROUTE}?mode=bounds&base=${opts.base}&max=${opts.maxObjectSize}`,
          encodeBoundsRequest(payload, bounds),
        ),
    };
  }),
);
