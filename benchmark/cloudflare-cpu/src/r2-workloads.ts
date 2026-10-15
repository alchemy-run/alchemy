import { createHash } from "node:crypto";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";

// workerd provides this constructor. Keep the harness's type dependency local;
// this declaration is erased and never replaces the deployed implementation.
declare const FixedLengthStream: {
  new (length: number): TransformStream<Uint8Array, Uint8Array>;
};

export const CpuCopyBucket = Cloudflare.R2.Bucket("CpuCopyBucket", { forceDestroy: true });
export const r2Sizes = [1, 16, 64] as const;
export type R2Size = (typeof r2Sizes)[number];
export type CopyMode = "effect" | "native";

// Generated once from bytes[i] = (i * 73 + 19) & 255. Never hash/generate
// source bytes in a measured copy request. Seed and verify are separate routes.
export const r2Fixtures = {
  1: {
    bytes: 1048576,
    checksum: 133693440,
    sha256: "e91db7585175e26eed3527e57a3cbd55a8832e64f7021ab1c64c067dcc990ab2",
  },
  16: {
    bytes: 16777216,
    checksum: 2139095040,
    sha256: "e3e019b9bf017a8fd1de597964e880a5ad5145e115132f92849cd2b28a1f7232",
  },
  64: {
    bytes: 67108864,
    checksum: 8556380160,
    sha256: "39615dc73614a616858fcbe5ccc2e47e22cd2de9a9adad99065435d22a5fbaff",
  },
} as const;

const seedKey = (mib: R2Size) => `seed/${mib}`;
const copyKey = (mode: CopyMode, mib: R2Size) => `copy/${mode}/${mib}`;
const pattern = Uint8Array.from({ length: 65536 }, (_, index) => (index * 73 + 19) & 255);

/** Bounded seed upload, outside copy measurement; at most 64 KiB buffered. */
export const seedR2 = (r2: Cloudflare.R2.ReadWriteBucketClient, mib: R2Size) =>
  Effect.gen(function* () {
    const fixture = r2Fixtures[mib];
    let remaining: number = fixture.bytes;
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (remaining === 0) {
          controller.close();
          return;
        }
        controller.enqueue(pattern);
        remaining -= pattern.length;
      },
    }).pipeThrough(new FixedLengthStream(fixture.bytes));
    const object = yield* r2.put(seedKey(mib), source, {
      sha256: fixture.sha256,
      customMetadata: { sha256: fixture.sha256 },
    });
    if (object.size !== fixture.bytes) return yield* Effect.die(new Error("Seed size mismatch"));
    return { ok: true, operation: "seed", mib, key: seedKey(mib), ...fixture, etag: object.etag };
  });

/** Actual R2 get + put; unchanged body, supplied checksum and metadata. */
export const copyR2 = (r2: Cloudflare.R2.ReadWriteBucketClient, mib: R2Size, mode: CopyMode) =>
  Effect.gen(function* () {
    const fixture = r2Fixtures[mib];
    const source = yield* r2.get(seedKey(mib));
    if (
      source === null ||
      source.size !== fixture.bytes ||
      source.customMetadata?.sha256 !== fixture.sha256
    ) {
      return yield* Effect.die(
        new Error("Seed is missing or has unexpected size/SHA-256 metadata"),
      );
    }
    const body = mode === "native" ? source.readable : source.body;
    if (body === undefined) return yield* Effect.die(new Error("Native source stream unavailable"));
    const target = yield* r2.put(copyKey(mode, mib), body, {
      contentLength: source.size,
      sha256: fixture.sha256,
      customMetadata: { source: seedKey(mib), sha256: fixture.sha256 },
    });
    if (target.size !== fixture.bytes) return yield* Effect.die(new Error("Copied size mismatch"));
    return {
      ok: true,
      endpoint: `r2-copy-${mode}`,
      mode,
      mib,
      count: mib,
      bytes: target.size,
      sha256: fixture.sha256,
      etag: target.etag,
      sourceKey: seedKey(mib),
      targetKey: copyKey(mode, mib),
    };
  });

/** Full byte-pattern + incremental SHA-256 verification, never timed as copy. */
export const verifyR2 = (
  r2: Cloudflare.R2.ReadWriteBucketClient,
  mib: R2Size,
  mode: CopyMode | "seed",
) =>
  Effect.gen(function* () {
    const fixture = r2Fixtures[mib];
    const key = mode === "seed" ? seedKey(mib) : copyKey(mode, mib);
    const object = yield* r2.get(key);
    if (
      object === null ||
      object.readable === undefined ||
      object.size !== fixture.bytes ||
      object.customMetadata?.sha256 !== fixture.sha256 ||
      (mode !== "seed" && object.customMetadata?.source !== seedKey(mib))
    ) {
      return yield* Effect.die(new Error("Verification object/size/metadata mismatch"));
    }
    const digest = yield* Effect.promise(async () => {
      const reader = object.readable!.getReader();
      const hash = createHash("sha256");
      let bytes = 0;
      let checksum = 0;
      try {
        for (;;) {
          const item = await reader.read();
          if (item.done) break;
          hash.update(item.value);
          for (let index = 0; index < item.value.length; index++) {
            const value = item.value[index]!;
            if (value !== ((bytes + index) * 73 + 19) % 256) {
              throw new Error(`Verification byte mismatch at ${bytes + index}`);
            }
            checksum += value;
          }
          bytes += item.value.length;
          if (bytes > fixture.bytes) throw new Error("Verification stream exceeded expected size");
        }
      } finally {
        reader.releaseLock();
      }
      return { bytes, checksum, sha256: hash.digest("hex") };
    });
    if (
      digest.bytes !== fixture.bytes ||
      digest.checksum !== fixture.checksum ||
      digest.sha256 !== fixture.sha256
    ) {
      return yield* Effect.die(new Error("Verification digest/size/checksum mismatch"));
    }
    return { ok: true, operation: "verify", mode, mib, key, ...digest, etag: object.etag };
  });
