import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import type { PlatformError } from "effect/PlatformError";
import * as Path from "effect/Path";
import { gzipSync } from "node:zlib";

export const COMPUTE_MANIFEST_VERSION = "1";

export interface ComputeArchiveOptions {
  /**
   * Directory whose files should be uploaded as the compute bundle.
   */
  directory: string;
  /**
   * Entrypoint relative to `directory`.
   */
  entrypoint: string;
}

interface TarEntry {
  name: string;
  body: Uint8Array;
  mode: number;
}

/**
 * Create the `tar.gz` artifact consumed by Prisma Compute.
 *
 * Files are added under the `bundle/` prefix, with a synthetic
 * `compute.manifest.json` at the archive root.
 */
export const createComputeArchive = Effect.fn(function* ({
  directory,
  entrypoint,
}: ComputeArchiveOptions): Effect.fn.Return<
  Uint8Array,
  PlatformError | Error,
  FileSystem.FileSystem | Path.Path
> {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = path.resolve(directory);
  const realRoot = yield* fs.realPath(root);
  const normalizedEntrypoint = yield* normalizeEntrypoint(entrypoint);
  const entrypointPath = path.join(root, normalizedEntrypoint);
  const entrypointExists = yield* fs.exists(entrypointPath);
  if (!entrypointExists) {
    return yield* Effect.fail(
      new Error(
        `Entrypoint not found in compute artifact: ${normalizedEntrypoint}`,
      ),
    );
  }
  const entrypointStat = yield* fs.stat(entrypointPath);
  if (entrypointStat.type !== "File") {
    return yield* Effect.fail(
      new Error(
        `Entrypoint must be a file in compute artifact: ${normalizedEntrypoint}`,
      ),
    );
  }
  yield* resolvePathWithinRoot(realRoot, entrypointPath);
  const names = (yield* fs.readDirectory(root, { recursive: true }))
    .map((name) => name.replaceAll("\\", "/"))
    .filter((name) => name.length > 0)
    .sort();

  const entries: TarEntry[] = [];
  for (const name of names) {
    const file = path.join(root, name);
    const stat = yield* fs.stat(file);
    if (stat.type !== "File") continue;
    yield* resolvePathWithinRoot(realRoot, file);
    entries.push({
      name: `bundle/${name}`,
      body: yield* fs.readFile(file),
      mode: stat.mode & 0o777,
    });
  }

  entries.push({
    name: "compute.manifest.json",
    mode: 0o644,
    body: yield* Effect.sync(() =>
      new TextEncoder().encode(
        JSON.stringify(
          {
            manifestVersion: COMPUTE_MANIFEST_VERSION,
            entrypoint: `bundle/${normalizedEntrypoint}`,
          },
          null,
          2,
        ),
      ),
    ),
  });

  return yield* Effect.sync(() => gzipSync(createTar(entries)));
});

export const normalizeEntrypoint = (entrypoint: string) =>
  Effect.gen(function* () {
    const normalized = entrypoint.replaceAll("\\", "/");
    if (normalized.trim().length === 0) {
      return yield* Effect.fail(new Error("entrypoint must be non-empty"));
    }
    if (normalized.startsWith("/") || /^[a-zA-Z]:\//.test(normalized)) {
      return yield* Effect.fail(new Error("entrypoint must be relative"));
    }
    const parts = normalized.split("/").filter((part) => part !== ".");
    if (parts.some((part) => part === ".." || part.length === 0)) {
      return yield* Effect.fail(
        new Error("entrypoint must not contain empty or parent segments"),
      );
    }
    return parts.join("/");
  });

const resolvePathWithinRoot = Effect.fn(function* (
  realRoot: string,
  candidate: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const realCandidate = yield* fs.realPath(candidate);
  const relative = path.relative(realRoot, realCandidate);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    return yield* Effect.fail(
      new Error(`Archive path escapes compute artifact root: ${candidate}`),
    );
  }
  return realCandidate;
});

const createTar = (entries: TarEntry[]) => {
  const chunks: Uint8Array[] = [];
  for (const entry of entries) {
    chunks.push(createHeader(entry));
    chunks.push(entry.body);
    const padding = paddingLength(entry.body.length);
    if (padding > 0) chunks.push(new Uint8Array(padding));
  }
  chunks.push(new Uint8Array(1024));
  return concat(chunks);
};

const createHeader = (entry: TarEntry) => {
  const header = new Uint8Array(512);
  const { name, prefix } = splitTarName(entry.name);

  writeString(header, 0, 100, name);
  writeOctal(header, 100, 8, entry.mode);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, entry.body.length);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  writeString(header, 156, 1, "0");
  writeString(header, 257, 6, "ustar");
  writeString(header, 263, 2, "00");
  writeString(header, 265, 32, "alchemy");
  writeString(header, 297, 32, "alchemy");
  if (prefix) writeString(header, 345, 155, prefix);

  const checksum = header.reduce((sum, value) => sum + value, 0);
  writeChecksum(header, checksum);
  return header;
};

const splitTarName = (name: string): { name: string; prefix?: string } => {
  if (byteLength(name) <= 100) return { name };
  const slashIndexes = Array.from(name.matchAll(/\//g), (match) => match.index);
  for (const index of slashIndexes.reverse()) {
    if (index === undefined) continue;
    const prefix = name.slice(0, index);
    const suffix = name.slice(index + 1);
    if (byteLength(prefix) <= 155 && byteLength(suffix) <= 100) {
      return { name: suffix, prefix };
    }
  }
  throw new Error(`Archive path is too long for tar header: ${name}`);
};

const byteLength = (value: string) => new TextEncoder().encode(value).length;

const writeString = (
  buffer: Uint8Array,
  offset: number,
  length: number,
  value: string,
) => {
  const bytes = new TextEncoder().encode(value);
  buffer.set(bytes.slice(0, length), offset);
};

const writeOctal = (
  buffer: Uint8Array,
  offset: number,
  length: number,
  value: number,
) => {
  const text = value
    .toString(8)
    .padStart(length - 1, "0")
    .slice(0, length - 1);
  writeString(buffer, offset, length, `${text}\0`);
};

const writeChecksum = (buffer: Uint8Array, checksum: number) => {
  const text = checksum.toString(8).padStart(6, "0").slice(0, 6);
  writeString(buffer, 148, 8, `${text}\0 `);
};

const paddingLength = (size: number) => (512 - (size % 512)) % 512;

const concat = (chunks: Uint8Array[]) => {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
};
