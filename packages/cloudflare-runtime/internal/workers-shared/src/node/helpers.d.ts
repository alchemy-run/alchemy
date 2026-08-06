import type { PathOrFileDescriptor } from "node:fs";
/** normalises sep for windows and prefix with `/` */
export declare const normalizeFilePath: (relativeFilepath: string) => string;
export declare const getContentType: (absFilePath: string) => string | null;
/**
 * Generate a function that can match relative filepaths against a list of gitignore formatted patterns.
 */
export declare function createPatternMatcher(
  patterns: Array<string>,
  exclude: boolean,
): (filePath: string) => boolean;
export declare function thrownIsDoesNotExistError(
  thrown: unknown,
): thrown is Error & {
  code: "ENOENT";
};
export declare function maybeGetFile(
  filePath: PathOrFileDescriptor,
): string | undefined;
/**
 * Create a function for filtering out ignored assets.
 *
 * The generated function takes an asset path, relative to the asset directory,
 * and returns true if the asset should not be ignored.
 */
export declare function createAssetsIgnoreFunction(dir: string): Promise<{
  assetsIgnoreFunction: (filePath: string) => boolean;
  assetsIgnoreFilePresent: boolean;
}>;
//# sourceMappingURL=helpers.d.ts.map
