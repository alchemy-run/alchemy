import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { createGunzip } from "node:zlib";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

const READ_CHUNK_BYTES = 64 * 1024;

export interface VerifiedFile {
  readonly _tag: "VerifiedFile" | "ArtifactFile";
  readonly path: string;
  readonly size: number;
  readonly mode: number;
  readonly identity: {
    readonly dev: string;
    readonly ino: string;
    readonly size: string;
    readonly mtimeNs: string;
    readonly ctimeNs: string;
  };
}

export interface ArtifactFile extends VerifiedFile {
  readonly _tag: "ArtifactFile";
  readonly sha256: string;
  readonly cleanup: Effect.Effect<void>;
}

export class ArtifactFileError extends Data.TaggedError("ArtifactFileError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const toArtifactFileError = (message: string) => (cause: unknown) =>
  new ArtifactFileError({ message: cause instanceof Error ? cause.message : message, cause });

const isSameIdentity = (stat: BigIntStats, identity: VerifiedFile["identity"]) =>
  stat.isFile() &&
  stat.dev.toString() === identity.dev &&
  stat.ino.toString() === identity.ino &&
  stat.size.toString() === identity.size &&
  stat.mtimeNs.toString() === identity.mtimeNs &&
  stat.ctimeNs.toString() === identity.ctimeNs;

const identityFrom = (stat: BigIntStats): VerifiedFile["identity"] => ({
  dev: stat.dev.toString(),
  ino: stat.ino.toString(),
  size: stat.size.toString(),
  mtimeNs: stat.mtimeNs.toString(),
  ctimeNs: stat.ctimeNs.toString(),
});

const validateLimit = (maxBytes: number) => {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error("Artifact maxBytes must be a positive safe integer.");
  }
};

const validateStat = (
  stat: BigIntStats,
  maxBytes: number,
  description: string,
  allowEmpty: boolean,
) => {
  if (!stat.isFile()) {
    throw new Error(`${description} must be a regular file.`);
  }
  if (!allowEmpty && stat.size <= 0n) {
    throw new Error(`${description} must be non-empty.`);
  }
  if (stat.size > BigInt(maxBytes) || stat.size > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`${description} exceeds the ${maxBytes} byte upload safety limit.`);
  }
};

async function* readVerifiedChunks(artifact: VerifiedFile): AsyncGenerator<Uint8Array> {
  const handle = await open(artifact.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    if (!isSameIdentity(before, artifact.identity)) {
      throw new Error(
        "Prisma deployment artifact changed after it was validated; rebuild or reselect the artifact before deploying.",
      );
    }

    let remaining = artifact.size;
    while (remaining > 0) {
      const buffer = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, remaining));
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, null);
      if (bytesRead === 0) {
        throw new Error("Prisma deployment artifact was truncated while it was being read.");
      }
      remaining -= bytesRead;
      yield new Uint8Array(buffer.buffer, buffer.byteOffset, bytesRead);
    }

    const trailing = Buffer.allocUnsafe(1);
    const { bytesRead: trailingBytes } = await handle.read(trailing, 0, trailing.byteLength, null);
    const after = await handle.stat({ bigint: true });
    if (trailingBytes !== 0 || !isSameIdentity(after, artifact.identity)) {
      throw new Error(
        "Prisma deployment artifact changed while it was being read; rebuild or reselect the artifact before deploying.",
      );
    }
  } finally {
    await handle.close();
  }
}

const inspectVerifiedFilePromise = async (
  inputPath: string,
  maxBytes: number,
  options?: {
    readonly allowEmpty?: boolean;
    readonly description?: string;
  },
) => {
  validateLimit(maxBytes);
  const description = options?.description ?? "File";
  const inputStat = await lstat(inputPath, { bigint: true });
  if (inputStat.isSymbolicLink()) {
    throw new Error(
      `${description} must not be a symbolic link; provide the regular file directly.`,
    );
  }
  validateStat(inputStat, maxBytes, description, options?.allowEmpty ?? false);
  const canonicalPath = await realpath(inputPath);
  const stat = await lstat(canonicalPath, { bigint: true });
  validateStat(stat, maxBytes, description, options?.allowEmpty ?? false);
  if (!isSameIdentity(stat, identityFrom(inputStat))) {
    throw new Error(
      `${description} changed while it was being validated; retry with a stable file.`,
    );
  }
  return {
    _tag: "VerifiedFile" as const,
    path: canonicalPath,
    size: Number(stat.size),
    mode: Number(stat.mode),
    identity: identityFrom(stat),
  } satisfies VerifiedFile;
};

export const inspectVerifiedFile = (
  inputPath: string,
  maxBytes: number,
  options?: {
    readonly allowEmpty?: boolean;
    readonly description?: string;
  },
) =>
  Effect.tryPromise({
    try: () => inspectVerifiedFilePromise(inputPath, maxBytes, options),
    catch: toArtifactFileError("Failed to validate file."),
  });

export const inspectArtifactFile = (
  inputPath: string,
  maxBytes: number,
  options?: {
    readonly cleanup?: Effect.Effect<void>;
    readonly description?: string;
  },
) =>
  Effect.tryPromise({
    try: async (signal) => {
      const description = options?.description ?? "Prisma deployment artifact";
      const verified = await inspectVerifiedFilePromise(inputPath, maxBytes, {
        description,
      });
      const hash = createHash("sha256");
      for await (const chunk of readVerifiedChunks(verified)) {
        if (signal.aborted) {
          throw new Error("Prisma deployment artifact validation was aborted.");
        }
        hash.update(chunk);
      }
      return {
        ...verified,
        _tag: "ArtifactFile" as const,
        sha256: hash.digest("hex"),
        cleanup: options?.cleanup ?? Effect.void,
      } satisfies ArtifactFile;
    },
    catch: toArtifactFileError("Failed to validate Prisma deployment artifact."),
  });

export const artifactFileStream = (artifact: ArtifactFile) =>
  Stream.fromAsyncIterable(
    readVerifiedChunks(artifact),
    toArtifactFileError("Failed to stream Prisma deployment artifact."),
  );

export const verifiedFileChunks = (file: VerifiedFile) => readVerifiedChunks(file);

export const readArtifactFile = (artifact: ArtifactFile) =>
  Effect.gen(function* () {
    const bytes = new Uint8Array(artifact.size);
    let offset = 0;
    yield* Stream.runForEach(artifactFileStream(artifact), (chunk) =>
      Effect.sync(() => {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }),
    );
    if (offset !== artifact.size) {
      return yield* new ArtifactFileError({
        message: "Prisma deployment artifact length changed while it was being read.",
      });
    }
    return bytes;
  });

/** What `findArchiveManifest` found at the root of a `tar.gz` artifact. */
export type ArchiveManifestCheck =
  | { readonly _tag: "NotGzip" }
  | { readonly _tag: "Corrupt" }
  | { readonly _tag: "Missing" }
  | { readonly _tag: "Invalid"; readonly reason: string }
  | { readonly _tag: "Found"; readonly entrypoint: string };

const MANIFEST_NAME = "compute.manifest.json";
const MAX_MANIFEST_BYTES = 64 * 1024;

const tarString = (block: Uint8Array, start: number, length: number) => {
  const field = block.subarray(start, start + length);
  const end = field.indexOf(0);
  return new TextDecoder().decode(end === -1 ? field : field.subarray(0, end));
};

const tarEntryName = (header: Uint8Array) => {
  const name = tarString(header, 0, 100);
  const prefix = tarString(header, 345, 155);
  const full = prefix.length > 0 ? `${prefix}/${name}` : name;
  return full.replace(/^\.\//, "");
};

const manifestCheck = (text: string): ArchiveManifestCheck => {
  try {
    const parsed = JSON.parse(text) as { manifestVersion?: unknown; entrypoint?: unknown };
    if (typeof parsed.manifestVersion !== "string") {
      return { _tag: "Invalid", reason: "it has no string manifestVersion" };
    }
    if (typeof parsed.entrypoint !== "string" || parsed.entrypoint.length === 0) {
      return { _tag: "Invalid", reason: "it has no entrypoint" };
    }
    return { _tag: "Found", entrypoint: parsed.entrypoint };
  } catch {
    return { _tag: "Invalid", reason: "it is not valid JSON" };
  }
};

/**
 * A tar reader fed decompressed bytes in order. `push` returns whether it
 * needs more; `result` is what it found.
 */
const manifestReader = () => {
  let buffered = new Uint8Array(0);
  let skip = 0;
  let manifestRemaining = -1;
  let manifest: Uint8Array[] = [];
  let result: ArchiveManifestCheck = { _tag: "Missing" };
  let done = false;
  const push = (chunk: Uint8Array): boolean => {
    const next = new Uint8Array(buffered.length + chunk.length);
    next.set(buffered);
    next.set(chunk, buffered.length);
    buffered = next;
    while (!done) {
      if (manifestRemaining >= 0) {
        const take = Math.min(manifestRemaining, buffered.length);
        manifest.push(buffered.slice(0, take));
        buffered = buffered.subarray(take);
        manifestRemaining -= take;
        if (manifestRemaining > 0) return true;
        result = manifestCheck(Buffer.concat(manifest).toString("utf8"));
        done = true;
        break;
      }
      if (skip > 0) {
        const take = Math.min(skip, buffered.length);
        buffered = buffered.subarray(take);
        skip -= take;
        if (skip > 0) return true;
      }
      if (buffered.length < 512) return true;
      const header = buffered.subarray(0, 512);
      buffered = buffered.subarray(512);
      if (header.every((byte) => byte === 0)) {
        done = true;
        break;
      }
      const size = Number.parseInt(tarString(header, 124, 12).trim() || "0", 8);
      if (tarEntryName(header) === MANIFEST_NAME && header[156] !== 0x35) {
        if (size > MAX_MANIFEST_BYTES) {
          result = { _tag: "Invalid", reason: "it is larger than 64 KiB" };
          done = true;
          break;
        }
        manifestRemaining = size;
        manifest = [];
        continue;
      }
      skip = Math.ceil(size / 512) * 512;
    }
    return false;
  };
  return { push, result: () => result };
};

const isGzip = (chunk: Uint8Array) => chunk[0] === 0x1f && chunk[1] === 0x8b;

const readError = toArtifactFileError(
  "Failed to read the Prisma deployment artifact as a tar.gz archive.",
);

/**
 * Read a `tar.gz` artifact's entries until `compute.manifest.json` at its root,
 * without unpacking it. The read stops at the manifest, and the file is closed
 * and the decompressor destroyed before this returns.
 *
 * Each file chunk is handed to the decompressor and its output consumed as it
 * is produced, so the decompressor never applies backpressure, and a write's
 * callback runs even after it is destroyed. No wait here can outlive its stream.
 */
export const findArchiveManifest = (artifact: VerifiedFile) =>
  Effect.gen(function* () {
    const reader = manifestReader();
    let needsMore = true;
    let notGzip = false;
    let corrupt: unknown;
    const gunzip = yield* Effect.acquireRelease(
      Effect.sync(() => {
        const stream = createGunzip();
        stream.on("data", (chunk: Uint8Array) => {
          if (needsMore) needsMore = reader.push(chunk);
        });
        stream.on("error", (error) => {
          corrupt ??= error;
        });
        return stream;
      }),
      (stream) => Effect.sync(() => stream.destroy()),
    );
    const settled = () => !needsMore || corrupt !== undefined;
    let first = true;
    yield* Stream.runForEachWhile(
      Stream.fromAsyncIterable(readVerifiedChunks(artifact), readError),
      (chunk) =>
        Effect.gen(function* () {
          if (first) {
            first = false;
            if (!isGzip(chunk)) {
              notGzip = true;
              return false;
            }
          }
          yield* Effect.callback<void>((resume) => {
            gunzip.write(chunk, () => resume(Effect.void));
          });
          return !settled();
        }),
    );
    if (notGzip || first) return { _tag: "NotGzip" } as const;
    if (!settled()) {
      yield* Effect.callback<void>((resume) => {
        const done = () => resume(Effect.void);
        gunzip.once("end", done);
        gunzip.once("error", done);
        gunzip.end();
      });
    }
    if (!needsMore || corrupt === undefined) return reader.result();
    return { _tag: "Corrupt" } as const;
  }).pipe(Effect.scoped);
