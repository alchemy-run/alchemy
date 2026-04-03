import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { DotAlchemy } from "../Config.ts";
import { Stack } from "../Stack.ts";
import { Stage } from "../Stage.ts";
import { sha256 } from "../Util/sha256.ts";
import type { BundleOptions } from "./Bundler.ts";
import { Bundler } from "./Bundler.ts";
import { cleanupBundleTempDir, createTempBundleDir } from "./TempRoot.ts";

export interface BundleRequest {
  readonly id: string;
  readonly main: string;
  /**
   * Produce the temp entry file content.
   * Receives the normalized relative import path to `main`.
   */
  readonly entryContent?: (importPath: string) => string;
  /** File extension for the output, including the dot (default: `".mjs"`). */
  readonly outExtension?: string;
  readonly build: Omit<BundleOptions, "entry" | "outfile">;
}

export interface BundleResult {
  readonly code: Uint8Array;
  /** SHA-256 hex digest of the bundled code. */
  readonly hash: string;
  /** Absolute path to the output file (useful for reading companion files like sourcemaps). */
  readonly outfile: string;
}

/**
 * Shared bundle pipeline used by both AWS Lambda and Cloudflare Container providers.
 *
 * 1. Computes a deterministic output path under `.alchemy/out/`
 * 2. Creates a temp staging directory next to the entry's package root
 * 3. Writes a caller-supplied entry file that imports `main`
 * 4. Runs the configured `Bundler`
 * 5. Reads the output and computes a content hash
 * 6. Cleans up the temp directory (even on failure)
 */
export const bundle = Effect.fnUntraced(function* (request: BundleRequest) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const bundler = yield* Bundler;
  const dotAlchemy = yield* DotAlchemy;
  const stack = yield* Stack;
  const stage = yield* Stage;

  const ext = request.outExtension ?? ".mjs";
  const outfile = path.join(
    dotAlchemy,
    "out",
    `${stack.name}-${stage}-${request.id}${ext}`,
  );

  const realMain = yield* fs.realPath(request.main);
  let entry = realMain;
  let tempDir: string | undefined;
  if (request.entryContent) {
    tempDir = yield* createTempBundleDir(realMain, dotAlchemy, request.id);
    const realTempDir = yield* fs.realPath(tempDir);
    const tempEntry = path.join(realTempDir, "__index.ts");

    let importPath = path.relative(realTempDir, realMain);
    if (!importPath.startsWith(".")) {
      importPath = `./${importPath}`;
    }
    importPath = importPath.replaceAll("\\", "/");

    yield* fs.writeFileString(tempEntry, request.entryContent(importPath));
    entry = tempEntry;
  }

  const run = Effect.gen(function* () {
    yield* bundler.build({
      ...request.build,
      entry,
      outfile,
    });
    const code = yield* fs.readFile(outfile);
    const hash = yield* sha256(code);
    return { code, hash, outfile } satisfies BundleResult;
  });

  return yield* (tempDir
    ? run.pipe(Effect.ensuring(cleanupBundleTempDir(tempDir)))
    : run);
});
