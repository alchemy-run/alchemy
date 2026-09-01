/**
 * The spilled-pack reader (src/Git/store/PackSource.ts): windowed random
 * access over blob storage. Reads within a window must be VIEWS of the
 * cached slab (a copy per probe read was the 40 s spilled-push ingest), and
 * a parse through tiny windows — many window boundaries, straddling
 * entries — must produce exactly what the in-memory parse produces.
 */
import {
  hashObject,
  makeSha1,
  encodeTypeSize,
  type Oid,
} from "@/Git/git/ObjectCodec.ts";
import { bufferRandomAccess, ingestPack } from "@/Git/git/PackParser.ts";
import { packHeader } from "@/Git/git/PackWriter.ts";
import * as Zlib from "@/Git/git/Zlib.ts";
import { makeObjectStore } from "@/Git/store/ObjectStore.ts";
import { blobRandomAccess, sliceRandomAccess } from "@/Git/store/PackSource.ts";
import { describe, expect, test } from "alchemy-test";
import * as Effect from "effect/Effect";
import { concat } from "./harness/pack.ts";
import { makeMemoryBlobStore, makeTestSqlClient } from "./harness/store.ts";

/** A synthetic non-delta pack of `n` blobs with sizes cycling 100..5000. */
const buildPack = (n: number) =>
  Effect.gen(function* () {
    const pieces: Array<Uint8Array> = [packHeader(n)];
    const oids: Array<Oid> = [];
    for (let i = 0; i < n; i++) {
      const size = 100 + ((i * 977) % 4900);
      const content = new Uint8Array(size);
      for (let j = 0; j < size; j++) content[j] = (j * 7 + i) & 0xff;
      oids.push(yield* hashObject(3, content));
      pieces.push(encodeTypeSize(3, size), yield* Zlib.deflate(content));
    }
    const body = concat(pieces);
    const sha = makeSha1();
    sha.update(body);
    return { pack: concat([body, sha.digest()]), oids };
  });

const parseWith = (source: ReturnType<typeof bufferRandomAccess>) =>
  Effect.gen(function* () {
    const store = makeObjectStore({
      sql: makeTestSqlClient(),
      blobs: makeMemoryBlobStore(),
      repoId: "R",
    });
    const seen: Array<string> = [];
    const summary = yield* ingestPack({
      source,
      store,
      sink: (entry) =>
        Effect.sync(() => {
          seen.push(entry.oid);
        }),
    });
    return { count: summary.count, seen };
  });

describe("blobRandomAccess", () => {
  test("reads inside one window are views of the cached slab, not copies", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const blobs = makeMemoryBlobStore();
        const bytes = new Uint8Array(10_000);
        for (let i = 0; i < bytes.length; i++) bytes[i] = i & 0xff;
        yield* blobs.put("k", bytes);
        const source = blobRandomAccess({
          blobs,
          key: "k",
          size: bytes.length,
          windowBytes: 4096,
          maxWindows: 2,
        });
        const a = yield* source.read(10, 100);
        const b = yield* source.read(200, 1000);
        expect(a.buffer).toBe(b.buffer); // same slab
        expect(a[0]).toBe(10);
        expect(b[0]).toBe(200);
        expect(blobs.gets.length).toBe(1); // one window fetch served both
        // Crossing a window boundary assembles a fresh buffer.
        const c = yield* source.read(4000, 200);
        expect(c.length).toBe(200);
        expect(c[96]).toBe(4096 & 0xff);
        expect(blobs.gets.length).toBe(2);
        // A read past the end is clipped.
        const tail = yield* source.read(9_990, 100);
        expect(tail.length).toBe(10);
      }),
    );
  });

  test("a parse through 1 KiB windows equals the in-memory parse (boundaries, straddles, eviction)", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { pack, oids } = yield* buildPack(300);
        expect(pack.length).toBeGreaterThan(50_000);
        const memory = yield* parseWith(bufferRandomAccess(pack));
        const blobs = makeMemoryBlobStore();
        // Emulate the wire body: a request prefix before the pack, then the pack.
        const prefix = new TextEncoder().encode("0000".repeat(37));
        yield* blobs.put("incoming", concat([prefix, pack]));
        const spilled = sliceRandomAccess(
          blobRandomAccess({
            blobs,
            key: "incoming",
            size: prefix.length + pack.length,
            windowBytes: 1024,
            maxWindows: 3,
          }),
          prefix.length,
        );
        const windowed = yield* parseWith(spilled);
        expect(windowed.count).toBe(300);
        expect(windowed.seen).toEqual(memory.seen);
        expect(new Set(windowed.seen)).toEqual(new Set(oids));
      }),
    );
  });

  test("with production geometry (large windows) a sequential parse fetches about one window each", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { pack } = yield* buildPack(600);
        const blobs = makeMemoryBlobStore();
        yield* blobs.put("incoming", pack);
        const windowBytes = 64 * 1024;
        const windows = Math.ceil(pack.length / windowBytes);
        expect(windows).toBeGreaterThan(3);
        const parsed = yield* parseWith(
          blobRandomAccess({
            blobs,
            key: "incoming",
            size: pack.length,
            windowBytes,
            maxWindows: 4,
          }),
        );
        expect(parsed.count).toBe(600);
        // Every window once, plus at most one re-read per window edge an
        // entry's probe straddles (the LRU holds 4, the parse is sequential).
        expect(blobs.gets.length).toBeLessThanOrEqual(windows * 2);
      }),
    );
  });
});
