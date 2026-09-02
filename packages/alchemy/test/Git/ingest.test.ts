/**
 * The hasher-driven ingest (src/Git/RepoObject.ts `ingestPackFrom` with a
 * hasher, DESIGN §22.7) over the store harness: tiny parts force every
 * delta base into an earlier part, so cross-part resolution after the end
 * and thin-pack bases from the store are exercised in-process.
 */
import * as BunServices from "@effect/platform-bun/BunServices";
import { bufferRandomAccess } from "@/Git/git/PackParser.ts";
import { HasherInline, Hasher } from "@/Git/Hasher.ts";
import { ingestPackFrom, ingestStoreOf } from "@/Git/RepoObject.ts";
import { makeObjectStore } from "@/Git/store/ObjectStore.ts";
import { makeStreamingSource } from "@/Git/store/StreamingSource.ts";
import { hashObject, encodeTypeSize, makeSha1 } from "@/Git/git/ObjectCodec.ts";
import { packHeader } from "@/Git/git/PackWriter.ts";
import * as Zlib from "@/Git/git/Zlib.ts";
import * as Fiber from "effect/Fiber";
import { concat } from "./harness/pack.ts";
import { describe, expect, test } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { makeMemoryBlobStore, makeTestSqlClient } from "./harness/store.ts";

const fixture = (name: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = path.join(import.meta.dirname, "fixtures", "packs");
    const pack = yield* fs.readFile(path.join(dir, name));
    const manifest = JSON.parse(
      yield* fs.readFileString(path.join(dir, "manifest.json")),
    ) as {
      packs: Record<string, { oids: ReadonlyArray<string> }>;
    };
    return { pack, manifest };
  });

describe("ingestPackFrom through the hasher", () => {
  test("ofs-delta fixture in 64-byte parts: every object staged, cross-part deltas resolved after the end", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { pack, manifest } = yield* fixture("ofs-delta.pack");
        const sql = makeTestSqlClient();
        const store = makeObjectStore({
          sql,
          blobs: makeMemoryBlobStore(),
          repoId: "R",
        });
        const hasher = yield* Hasher;
        const outcome = yield* Effect.result(
          ingestPackFrom(bufferRandomAccess(pack), {
            store: ingestStoreOf(store),
            pushId: "push-1",
            hasher,
            partBytes: 64,
          }),
        );
        if (outcome._tag === "Failure")
          throw new Error(`${outcome.failure._tag}: ${outcome.failure.reason}`);
        const result = outcome.success;
        const expected = manifest.packs["ofs-delta"]!.oids;
        expect(result.objectCount).toBe(expected.length);
        const staged = yield* sql.all<{ oid: string }>(
          `SELECT oid FROM objects WHERE staged_push = 'push-1' ORDER BY oid`,
        );
        expect(staged.map((r) => r.oid)).toEqual([...expected].sort());
      }).pipe(Effect.provide(HasherInline), Effect.provide(BunServices.layer)),
    );
  });

  test("a corrupted trailer is rejected by the pipeline's lagged hash", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { pack } = yield* fixture("simple.pack");
        const bad = Uint8Array.from(pack);
        bad[bad.length - 3] ^= 0x01;
        const store = makeObjectStore({
          sql: makeTestSqlClient(),
          blobs: makeMemoryBlobStore(),
          repoId: "R",
        });
        const hasher = yield* Hasher;
        const r = yield* Effect.result(
          ingestPackFrom(bufferRandomAccess(bad), {
            store: ingestStoreOf(store),
            pushId: "p",
            hasher,
            partBytes: 4096,
          }),
        );
        expect(r._tag).toBe("Failure");
        if (r._tag === "Failure")
          expect(r.failure.reason).toContain("checksum");
      }).pipe(Effect.provide(HasherInline), Effect.provide(BunServices.layer)),
    );
  });
});

describe("hasher pipeline over a streaming source with eviction", () => {
  test(
    "a multi-part pack whose retained window is smaller than a part stages every inline row and completes (no fallback)",
    async () => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const n = 1500;
          const pieces: Array<Uint8Array> = [packHeader(n)];
          for (let i = 0; i < n; i++) {
            const c = new Uint8Array(1000 + (i % 700));
            crypto.getRandomValues(c);
            yield* hashObject(3, c);
            pieces.push(encodeTypeSize(3, c.length), yield* Zlib.deflate(c));
          }
          const body = concat(pieces);
          const sha = makeSha1();
          sha.update(body);
          const pack = concat([body, sha.digest()]);
          // Parts of 64 KiB, retention of 128 KiB, no spill/fallback: every
          // inline row must be read back before its bytes are dropped.
          const feeder = makeStreamingSource({
            slabBytes: 32 * 1024,
            retainBytes: 128 * 1024,
            backpressureBytes: 1 << 20,
          });
          const sql = makeTestSqlClient();
          const store = makeObjectStore({
            sql,
            blobs: makeMemoryBlobStore(),
            repoId: "R",
          });
          const hasher = yield* Hasher;
          const ingest = yield* Effect.forkChild(
            Effect.result(
              ingestPackFrom(feeder.source, {
                store: ingestStoreOf(store),
                pushId: "p",
                hasher,
                partBytes: 64 * 1024,
              }),
            ),
          );
          for (let at = 0; at < pack.length; at += 50_000)
            yield* feeder.push(pack.subarray(at, at + 50_000));
          feeder.end();
          const r = yield* Fiber.join(ingest).pipe(
            Effect.timeout("20 seconds"),
          );
          expect(r._tag).toBe("Success");
          const staged = yield* sql.first<{ n: number; withBytes: number }>(
            `SELECT COUNT(*) AS n, SUM(LENGTH(zdata) > 0) AS withBytes FROM objects WHERE staged_push = 'p'`,
          );
          expect(staged?.n).toBe(n);
          expect(staged?.withBytes).toBe(n);
        }).pipe(Effect.provide(HasherInline)),
      );
    },
    { timeout: 30_000 },
  );
});

describe("raw-chunk dispatch with resync and stitching (DESIGN §22.9)", () => {
  test("the ofs-delta fixture in 64-byte chunks: every straddler stitched, every delta resolved", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { pack, manifest } = yield* fixture("ofs-delta.pack");
        const sql = makeTestSqlClient();
        const store = makeObjectStore({
          sql,
          blobs: makeMemoryBlobStore(),
          repoId: "R",
        });
        const hasher = yield* Hasher;
        for (const partBytes of [64, 200, 1000, 1 << 20]) {
          yield* sql.run(`DELETE FROM objects`);
          const outcome = yield* Effect.result(
            ingestPackFrom(bufferRandomAccess(pack), {
              store: ingestStoreOf(store),
              pushId: "p",
              hasher,
              partBytes,
            }),
          );
          if (outcome._tag === "Failure")
            throw new Error(
              `parts of ${partBytes}: ${outcome.failure._tag}: ${outcome.failure.reason}`,
            );
          const result = outcome.success;
          const expected = manifest.packs["ofs-delta"]!.oids;
          expect(result.objectCount, `parts of ${partBytes}`).toBe(
            expected.length,
          );
          const staged = yield* sql.all<{ oid: string }>(
            `SELECT oid FROM objects WHERE staged_push = 'p' ORDER BY oid`,
          );
          expect(
            staged.map((r) => r.oid),
            `parts of ${partBytes}`,
          ).toEqual([...expected].sort());
        }
      }).pipe(Effect.provide(HasherInline), Effect.provide(BunServices.layer)),
    );
  });
});
