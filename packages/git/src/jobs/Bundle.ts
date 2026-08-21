/**
 * The clone-bundle alarm job (DESIGN.md §12.2) — the v2 serving plane.
 *
 * A clone is, on the wire, exactly one pack containing the closure of the
 * advertised refs. v1 recomputes that pack per clone (walk the commit graph,
 * walk every tree, emit every object). A **bundle** computes it once, after
 * pushes settle, and stores it in R2 under a key derived from the ref
 * snapshot it covers:
 *
 * ```
 * {repoId}/bundles/bundle-{refsHash}.pack
 * ```
 *
 * Serving a clone then becomes "stream these bytes" — no closure walk, no
 * per-object reads, no compression. Because the key is content-addressed by
 * its ref snapshot, the bytes are immutable and therefore cacheable at every
 * edge PoP, and the Worker can stream them straight to the client without
 * the Durable Object touching a single pack byte.
 *
 * The pack is streamed to R2 with a **precomputed content length** (every
 * entry is `varint(type,size) + zdata`, and both are known from the object
 * index), so bundling a large repo never buffers the pack in memory.
 */
import { BlobStoreError, type BlobStoreShape } from "../BlobStore.ts";
import { RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import {
  encodeTypeSize,
  makeSha1,
  type Oid,
  type PackEntryType,
} from "../git/ObjectCodec.ts";
import { StoreError, type ManifestEntry } from "../git/Store.ts";
import { bundleKey } from "../store/Keys.ts";

/** A ref as it appears in a bundle's covered snapshot. */
export interface BundleRef {
  readonly name: string;
  readonly oid: string;
}

/**
 * What a repo records about its current bundle (stored as JSON in the
 * `config` table under `bundle`).
 */
export interface BundleInfo {
  /** sha1 over the sorted `name oid` lines the bundle covers. */
  readonly refsHash: string;
  /** Full R2 key of the pack. */
  readonly key: string;
  /** Object count inside the pack. */
  readonly objectCount: number;
  /** Exact byte length of the pack. */
  readonly size: number;
  /** The ref snapshot this bundle covers. */
  readonly refs: ReadonlyArray<BundleRef>;
  /** Epoch millis the bundle was cut. */
  readonly createdAt: number;
}

/**
 * Repos larger than this are not bundled in v2.0 — the win is clone-storm
 * absorption on ordinary repos, and an unbounded bundle job would monopolise
 * the alarm budget. (The streaming multipart upgrade lifts this.)
 */
export const MAX_BUNDLE_BYTES = 512 * 1024 * 1024;

/**
 * sha1 over the sorted `"<name> <oid>"` lines — the identity of a ref
 * snapshot. Two repos states with the same refs produce the same hash, so
 * the bundle key is stable and immutable.
 */
export const hashRefs = (refs: ReadonlyArray<BundleRef>): string => {
  const hash = makeSha1();
  const lines = [...refs]
    .map((ref) => `${ref.name} ${ref.oid}`)
    .sort()
    .join("\n");
  hash.update(new TextEncoder().encode(lines));
  return hash.digestHex();
};

/**
 * Exact byte length of the pack `entries` will produce: the 12-byte header,
 * each entry's varint type/size header plus its stored zdata, and the
 * 20-byte trailer. Lets the bundle stream straight into R2 without
 * buffering.
 */
export const packByteLength = (
  entries: ReadonlyArray<ManifestEntry>,
): number => {
  let total = 12 + 20;
  for (const entry of entries) {
    total +=
      encodeTypeSize(entry.type as PackEntryType, entry.size).length +
      entry.zsize;
  }
  return total;
};

/** Dependencies of {@link runBundleJob}. */
export interface BundleJobOptions {
  readonly repoId: string;
  readonly refs: ReadonlyArray<BundleRef>;
  /** The full-clone manifest (closure of every ref). */
  readonly entries: ReadonlyArray<ManifestEntry>;
  /** Emits the pack for `entries` — `RepoObject`'s `packStream`. */
  readonly packStream: (
    entries: ReadonlyArray<ManifestEntry>,
  ) => Stream.Stream<Uint8Array, StoreError>;
  readonly blobs: BlobStoreShape;
  readonly maxBytes?: number | undefined;
}

/**
 * Cuts a clone bundle for the given ref snapshot and returns what to record
 * on the repo. Returns `undefined` when the repo is too large to bundle in
 * v2.0 or has no refs (nothing to clone).
 */
export const runBundleJob = (
  options: BundleJobOptions,
): Effect.Effect<BundleInfo | undefined, StoreError> =>
  Effect.gen(function* () {
    if (options.refs.length === 0 || options.entries.length === 0) {
      return undefined;
    }
    const size = packByteLength(options.entries);
    if (size > (options.maxBytes ?? MAX_BUNDLE_BYTES)) {
      return undefined;
    }
    const refsHash = yield* Effect.sync(() => hashRefs(options.refs));
    const key = bundleKey(options.repoId, refsHash);

    // The pack streams straight into R2 (its byte length is known up front),
    // so a large bundle is never buffered. StoreError may surface from the
    // stream itself (an object read failing mid-pack); R2Error from the put.
    yield* options.blobs
      .put(
        key,
        options
          .packStream(options.entries)
          .pipe(
            Stream.mapError(
              (error) => new BlobStoreError({ reason: error.reason }),
            ),
          ),
        { contentLength: size },
      )
      .pipe(
        Effect.mapError(
          (error: BlobStoreError) =>
            new StoreError({ reason: `blob put ${key}: ${error.reason}` }),
        ),
        Effect.provide(RuntimeContext.phantom),
      );

    return {
      refsHash,
      key,
      objectCount: options.entries.length,
      size,
      refs: options.refs,
      createdAt: Date.now(),
    } satisfies BundleInfo;
  });

/**
 * Decides whether a recorded bundle can serve this fetch (DESIGN.md §12.2,
 * tier 1 "exact match").
 *
 * The bundle holds the closure of the refs it covers, so it is safe for any
 * request that:
 *
 * - brings no `have`s and no shallow state (it is a *clone*, not an
 *   incremental fetch — otherwise the client would receive objects it
 *   already has, which is legal but wasteful, or miss the negotiation the
 *   protocol promised), and
 * - wants only oids the bundle actually covers.
 *
 * Extra objects in a pack are legal, so a superset bundle serves a
 * single-branch clone fine.
 */
export const bundleCovers = (
  bundle: BundleInfo,
  request: {
    readonly wants: ReadonlyArray<Oid>;
    readonly haves: ReadonlyArray<Oid>;
    readonly depth?: number | undefined;
    readonly clientShallow: ReadonlyArray<Oid>;
  },
): boolean => {
  if (
    request.haves.length > 0 ||
    request.depth !== undefined ||
    request.clientShallow.length > 0 ||
    request.wants.length === 0
  ) {
    return false;
  }
  const covered = new Set(bundle.refs.map((ref) => ref.oid));
  return request.wants.every((want) => covered.has(want));
};
