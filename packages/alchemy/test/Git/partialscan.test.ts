/**
 * The partial-pack scanner (src/Git/git/PartialScan.ts): the hashing
 * Worker's unit of work. Entries are settled inside a buffer that starts
 * at an entry boundary; the tail is carried; deltas whose base lies in an
 * earlier buffer are reported unresolved.
 */
import {
  hashObject,
  encodeTypeSize,
  makeSha1,
  type Oid,
} from "@/Git/git/ObjectCodec.ts";
import { scanPart } from "@/Git/git/PartialScan.ts";
import { packHeader } from "@/Git/git/PackWriter.ts";
import * as Zlib from "@/Git/git/Zlib.ts";
import * as BunServices from "@effect/platform-bun/BunServices";
import { describe, expect, test } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { concat } from "./harness/pack.ts";

const buildPack = (n: number) =>
  Effect.gen(function* () {
    const pieces: Array<Uint8Array> = [packHeader(n)];
    const oids: Array<Oid> = [];
    for (let i = 0; i < n; i++) {
      const size = 100 + ((i * 977) % 4900);
      const content = new Uint8Array(size);
      crypto.getRandomValues(content);
      content[0] = i & 0xff;
      oids.push(yield* hashObject(3, content));
      pieces.push(encodeTypeSize(3, size), yield* Zlib.deflate(content));
    }
    const body = concat(pieces);
    const sha = makeSha1();
    sha.update(body);
    return { pack: concat([body, sha.digest()]), oids, count: n };
  });

/** Drives the scanner the way the pipeline does: parts + carry. */
const scanInParts = (
  pack: Uint8Array,
  count: number,
  partSizes: (i: number) => number,
) =>
  Effect.gen(function* () {
    // Parts run to the END of the pack (trailer included) so the last entry
    // is followed by bytes, per the scanner's contract.
    const end = pack.length;
    let consumedTo = 12; // after the pack header
    let remaining = count;
    let cursor = 12;
    const all: Array<Oid> = [];
    const unresolved: Array<{ offset: number }> = [];
    let i = 0;
    let carry = new Uint8Array(0);
    while (cursor < end) {
      const n = Math.min(partSizes(i++), end - cursor);
      const payload = concat([carry, pack.subarray(cursor, cursor + n)]);
      const base = consumedTo;
      const result = yield* scanPart(payload, {
        base,
        remaining,
        maxObjectSize: 64 << 20,
      });
      for (const e of result.entries) all.push(e.oid);
      for (const u of result.unresolved) unresolved.push(u);
      remaining -= result.count;
      cursor += n;
      carry = payload.subarray(result.consumedTo - base);
      consumedTo = result.consumedTo;
    }
    expect(remaining).toBe(0);
    expect(carry.length).toBe(20); // exactly the trailer is left over
    return { all, unresolved };
  });

describe("scanPart", () => {
  test("a pack split at arbitrary points, with carry, yields every entry exactly once", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { pack, oids, count } = yield* buildPack(400);
        for (const sizes of [
          () => 1000,
          (i: number) => 100 + ((i * 7919) % 5000),
          () => 1 << 20,
        ]) {
          const { all, unresolved } = yield* scanInParts(pack, count, sizes);
          expect(all.length).toBe(count);
          expect(new Set(all)).toEqual(new Set(oids));
          expect(unresolved).toEqual([]);
        }
      }),
    );
  });

  test("the ofs-delta fixture: whole-buffer scan resolves every delta; small parts report cross-part bases unresolved", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = path.join(import.meta.dirname, "fixtures", "packs");
        const pack = yield* fs.readFile(path.join(dir, "ofs-delta.pack"));
        const manifest = JSON.parse(
          yield* fs.readFileString(path.join(dir, "manifest.json")),
        ) as {
          packs: Record<string, { oids: ReadonlyArray<string> }>;
        };
        const expected = new Set(manifest.packs["ofs-delta"]!.oids);
        const count = new DataView(pack.buffer, pack.byteOffset).getUint32(8);
        const whole = yield* scanPart(pack.subarray(12), {
          base: 12,
          remaining: count,
          maxObjectSize: 64 << 20,
        });
        expect(whole.unresolved).toEqual([]);
        expect(whole.count).toBe(count);
        expect(new Set(whole.entries.map((e) => e.oid))).toEqual(expected);
        expect(whole.entries.some((e) => e.zdata !== undefined)).toBe(true); // delta-resolved ones carry fresh zdata
        // Tiny parts: bases fall into earlier buffers.
        const { all, unresolved } = yield* scanInParts(pack, count, () => 64);
        expect(unresolved.length).toBeGreaterThan(0);
        expect(all.length + unresolved.length).toBe(count);
        for (const oid of all) expect(expected.has(oid)).toBe(true);
      }).pipe(Effect.provide(BunServices.layer)),
    );
  });
});

describe("an entry ending exactly at the buffer edge is not consumed", () => {
  test("the scanner carries it until bytes follow", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { pack, count } = yield* buildPack(3);
        const first = yield* scanPart(pack.subarray(12), {
          base: 12,
          remaining: count,
          maxObjectSize: 1 << 20,
        });
        expect(first.count).toBe(3);
        const cut = first.entries[1]!.dataOffset + first.entries[1]!.span;
        const partial = yield* scanPart(pack.subarray(12, cut), {
          base: 12,
          remaining: count,
          maxObjectSize: 1 << 20,
        });
        expect(partial.count).toBe(1);
        expect(partial.consumedTo).toBeLessThan(cut);
        expect(partial.consumedTo).toBe(
          first.entries[0]!.dataOffset + first.entries[0]!.span,
        );
      }),
    );
  });
});
