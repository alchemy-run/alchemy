/**
 * The hasher protocol (src/Git/Hasher.ts): a scan result survives the
 * binary encoding byte for byte, and the inline layer scans in-process.
 */
import {
  hashObject,
  encodeTypeSize,
  makeSha1,
  type Oid,
} from "@/Git/git/ObjectCodec.ts";
import { packHeader } from "@/Git/git/PackWriter.ts";
import * as Zlib from "@/Git/git/Zlib.ts";
import {
  decodeScanResult,
  encodeScanResult,
  Hasher,
  HasherInline,
} from "@/Git/Hasher.ts";
import { describe, expect, test } from "alchemy-test";
import { BlobStore } from "@/Git/BlobStore.ts";
import * as Effect from "effect/Effect";
import { makeMemoryBlobStore } from "./harness/store.ts";
import * as Layer from "effect/Layer";
import { concat } from "./harness/pack.ts";

describe("Hasher", () => {
  test("encode/decode round-trips entries, blob references, unresolved deltas and coordinates", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const pieces: Array<Uint8Array> = [packHeader(3)];
        const oids: Array<Oid> = [];
        // A blob, a tree (content returned), and another blob.
        const contents = [
          new Uint8Array(500),
          new TextEncoder().encode("100644 f\\0" + "x".repeat(20)),
          new Uint8Array(700),
        ];
        const types = [3, 2, 3] as const;
        for (let i = 0; i < 3; i++) {
          crypto.getRandomValues(contents[i]!.subarray(0, 0));
          oids.push(yield* hashObject(types[i], contents[i]!));
          pieces.push(
            encodeTypeSize(types[i], contents[i]!.length),
            yield* Zlib.deflate(contents[i]!),
          );
        }
        const body = concat(pieces);
        const sha = makeSha1();
        sha.update(body);
        const pack = concat([body, sha.digest()]);
        const hasher = yield* Hasher;
        const result = yield* hasher.hashPart(pack.subarray(12), {
          base: 12,
          remaining: 3,
          maxObjectSize: 1 << 20,
        });
        expect(result.count).toBe(3);
        expect(result.entries.map((e) => e.oid)).toEqual(oids);
        expect(result.entries[1]!.content).toBeDefined();
        expect(result.entries[0]!.content).toBeUndefined();
        const wire = encodeScanResult({
          ...result,
          unresolved: [
            { offset: 99, dataOffset: 101, span: 7, baseOffset: 42, size: 12 },
          ],
        });
        const back = decodeScanResult(wire);
        expect(back.count).toBe(3);
        expect(back.consumedTo).toBe(result.consumedTo);
        expect(back.unresolved).toEqual([
          { offset: 99, dataOffset: 101, span: 7, baseOffset: 42, size: 12 },
        ]);
        expect(
          back.entries.map((e) => [
            e.oid,
            e.type,
            e.size,
            e.dataOffset,
            e.span,
          ]),
        ).toEqual(
          result.entries.map((e) => [
            e.oid,
            e.type,
            e.size,
            e.dataOffset,
            e.span,
          ]),
        );
        expect(Array.from(back.entries[1]!.content!)).toEqual(
          Array.from(result.entries[1]!.content!),
        );
      }).pipe(
        Effect.provide(
          HasherInline.pipe(
            Layer.provide(Layer.succeed(BlobStore, makeMemoryBlobStore())),
          ),
        ),
      ),
    );
  });
});
