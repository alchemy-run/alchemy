/**
 * The pack hasher (DESIGN §22.7): the CPU-heavy half of push ingest —
 * inflating and hashing entries, applying in-buffer deltas — as a service
 * the receive-pack pipeline calls per spilled part, so the repo's Durable
 * Object only receives bytes and stages rows.
 *
 * Two layers:
 *
 * - {@link HasherInline} runs the scan in the calling isolate (tests, or a
 *   deployment without a self service binding).
 * - {@link HasherSelf} posts each part to the Worker's own
 *   `/_alchemy/git/hash` route through a `Cloudflare.Workers.Self` service
 *   binding, so every part is hashed in a fresh Worker isolate with its
 *   own CPU, in parallel with the upload the DO is receiving.
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
import { WorkerEnvironment } from "../Cloudflare/Workers/Worker.ts";
import { ADMIN_TOKEN_CONFIG_KEY } from "./Auth.ts";
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
  readonly base: number;
  readonly remaining: number;
  readonly maxObjectSize: number;
  /** The payload is a raw chunk: find the first boundary first (DESIGN §22.9). */
  readonly resync?: boolean | undefined;
}

export interface HasherShape {
  readonly hashPart: (
    payload: Uint8Array,
    options: HashPartOptions,
  ) => Effect.Effect<
    ScanResult,
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

/** Runs the scan in-process. */
export const HasherInline: Layer.Layer<Hasher> = Layer.succeed(Hasher, {
  hashPart: (payload, options) => scanPart(payload, options),
  hashBoundsPart: (payload, bounds, options) =>
    hashBounds(payload, bounds, options),
});

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
export const HasherSelf: Layer.Layer<Hasher, never, WorkerEnvironment> =
  Layer.effect(
    Hasher,
    Effect.gen(function* () {
      const env = yield* WorkerEnvironment;
      const fetcher = (env as Record<string, unknown>)[HASHER_BINDING] as
        | SelfFetcher
        | undefined;
      const adminKey = yield* Config.redacted(ADMIN_TOKEN_CONFIG_KEY).pipe(
        Effect.map(Redacted.value),
        Effect.orElseSucceed(() => undefined),
      );
      if (fetcher === undefined || adminKey === undefined) {
        return {
          hashPart: (payload, opts) => scanPart(payload, opts),
          hashBoundsPart: (payload, bounds, opts) =>
            hashBounds(payload, bounds, opts),
        };
      }
      const post = (url: string, body: Uint8Array) =>
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
          const bytes = new Uint8Array(
            yield* Effect.tryPromise({
              try: () => response.arrayBuffer(),
              catch: (error) =>
                new HashError({ reason: `hash part body: ${String(error)}` }),
            }),
          );
          if (response.status !== 200) {
            return yield* new HashError({
              reason: `hash part: status ${response.status}: ${new TextDecoder().decode(bytes.subarray(0, 200))}`,
            });
          }
          return decodeScanResult(bytes);
        });
      return {
        hashPart: (payload, opts) =>
          post(
            `https://self${HASH_ROUTE}?base=${opts.base}&remaining=${opts.remaining}&max=${opts.maxObjectSize}${opts.resync ? "&resync=1" : ""}`,
            payload,
          ),
        hashBoundsPart: (payload, bounds, opts) =>
          post(
            `https://self${HASH_ROUTE}?mode=bounds&base=${opts.base}&max=${opts.maxObjectSize}`,
            encodeBoundsRequest(payload, bounds),
          ),
      };
    }),
  );
