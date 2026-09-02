/**
 * The hasher-driven ingest (src/Git/RepoObject.ts `ingestPackFrom` with a
 * hasher, DESIGN §22.7) over the store harness: tiny parts force every
 * delta base into an earlier part, so cross-part resolution after the end
 * and thin-pack bases from the store are exercised in-process.
 */
import * as BunServices from "@effect/platform-bun/BunServices";
import { bufferRandomAccess } from "@/Git/git/PackParser.ts";
import { HasherInline, Hasher } from "@/Git/Hasher.ts";
import { ingestPackFrom } from "@/Git/RepoObject.ts";
import { makeObjectStore } from "@/Git/store/ObjectStore.ts";
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
        const result = yield* ingestPackFrom(bufferRandomAccess(pack), {
          store,
          pushId: "push-1",
          hasher,
          partBytes: 64,
        });
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
            store,
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
