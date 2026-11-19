import { isAbsolute, sep } from "node:path";
// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
import ignore from "@alchemy.run/node-utils/ignore";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import mime from "mime";
import {
  CF_ASSETS_IGNORE_FILENAME,
  HEADERS_FILENAME,
  REDIRECTS_FILENAME,
} from "../shared/constants.ts";

/** normalises sep for windows and prefix with `/` */
export const normalizeFilePath = (relativeFilepath: string) => {
  if (isAbsolute(relativeFilepath)) {
    throw new Error(`Expected relative path`);
  }
  return "/" + relativeFilepath.split(sep).join("/");
};

export const getContentType = (absFilePath: string) => {
  let contentType = mime.getType(absFilePath);
  if (contentType && contentType.startsWith("text/") && !contentType.includes("charset")) {
    contentType = `${contentType}; charset=utf-8`;
  }
  return contentType;
};

/**
 * Generate a function that can match relative filepaths against a list of gitignore formatted patterns.
 */
export function createPatternMatcher(
  patterns: Array<string>,
  exclude: boolean,
): (filePath: string) => boolean {
  if (patterns.length === 0) {
    return (_filePath) => !exclude;
  } else {
    const ignorer = ignore().add(patterns);
    return (filePath) => ignorer.test(filePath).ignored;
  }
}

/** An ignore file whose encoding cannot be used to match asset paths. */
export class InvalidAssetsIgnoreError extends Data.TaggedError("InvalidAssetsIgnoreError")<{
  readonly filePath: string;
}> {
  override get message() {
    return `The .assetsignore file at "${this.filePath}" must be UTF-8 encoded and must not contain null characters. Save the file as UTF-8 and try again.`;
  }
}

/** Read ignore patterns without silently replacing undecodable characters. */
const readAssetsIgnoreFile = Effect.fn(function* (filePath: string) {
  const fs = yield* FileSystem.FileSystem;
  const contents = yield* fs.readFile(filePath).pipe(
    Effect.catchIf(
      (error) => error.reason._tag === "NotFound",
      () => Effect.undefined,
    ),
  );
  if (contents === undefined) {
    return undefined;
  }
  return yield* Effect.try({
    try: () => {
      const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(contents);
      // BOM-less UTF-16 can be valid UTF-8 bytes but cannot form usable patterns.
      if (text.includes("\0")) {
        throw new Error("Ignore patterns contain a null character.");
      }
      return text;
    },
    catch: () => new InvalidAssetsIgnoreError({ filePath }),
  });
});

/**
 * Create a function for filtering out ignored assets.
 *
 * The generated function takes an asset path, relative to the asset directory,
 * and returns true if the asset should not be ignored.
 */
export const createAssetsIgnoreFunction = Effect.fn(function* (dir: string) {
  const path = yield* Path.Path;
  const cfAssetIgnorePath = path.join(dir, CF_ASSETS_IGNORE_FILENAME);

  const ignorePatterns = [
    // Ignore the `.assetsignore` file and other metafiles by default.
    // The ignore lib expects unix-style paths for its patterns
    `/${CF_ASSETS_IGNORE_FILENAME}`,
    `/${REDIRECTS_FILENAME}`,
    `/${HEADERS_FILENAME}`,
  ];

  const assetsIgnore = yield* readAssetsIgnoreFile(cfAssetIgnorePath);
  if (assetsIgnore !== undefined) {
    ignorePatterns.push(...assetsIgnore.split("\n"));
  }

  return {
    assetsIgnoreFunction: createPatternMatcher(ignorePatterns, true),
    assetsIgnoreFilePresent: assetsIgnore !== undefined,
  };
});
