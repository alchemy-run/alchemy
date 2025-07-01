import path from "node:path";

/**
 * Normalizes a path to be relative to the current working directory.
 * This ensures that paths saved to Alchemy state are portable between computers.
 *
 * @param inputPath - The path to normalize (can be absolute or relative)
 * @returns A relative path from the current working directory
 */
export function toRelativePath(inputPath: string): string {
  if (path.isAbsolute(inputPath)) {
    return path.relative(process.cwd(), inputPath);
  }
  // Already relative, just normalize it
  return path.normalize(inputPath);
}

/**
 * Converts a path to an absolute path.
 * If the path is already absolute, returns it normalized.
 * If the path is relative, resolves it from the current working directory.
 *
 * @param inputPath - The path to convert (can be absolute or relative)
 * @returns An absolute path
 */
export function toAbsolutePath(inputPath: string): string {
  if (path.isAbsolute(inputPath)) {
    return path.normalize(inputPath);
  }
  return path.resolve(process.cwd(), inputPath);
}

/**
 * Resolves a path relative to a base directory.
 *
 * @param basePath - The base directory path
 * @param relativePath - The path relative to the base directory
 * @returns An absolute path
 */
export function resolveFromBase(
  basePath: string,
  relativePath: string,
): string {
  const absoluteBase = toAbsolutePath(basePath);
  return path.resolve(absoluteBase, relativePath);
}
