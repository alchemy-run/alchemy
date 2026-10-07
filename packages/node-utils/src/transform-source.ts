import { existsSync, readFileSync, statSync } from "node:fs";
import * as inspector from "node:inspector";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { resolveTsconfig } from "rolldown/experimental";
import { parseSync, transformSync, TsconfigCache, type TransformOptions } from "rolldown/utils";
import type { OxcLoaderOptions } from "./register-oxc.ts";
import { resolveCacheDirectory, TransformCache } from "./transform-cache.ts";

/** Extensions Oxc transpiles; everything else is JavaScript Node can run. */
export const transformExtensions = new Set([".ts", ".tsx", ".mts", ".cts", ".jsx"]);

export type ModuleFormat = "module" | "commonjs";

/**
 * Module format from Node's `load` hook context. Node derives these from the
 * extension and the nearest `package.json#type`; `*-typescript` variants are
 * its TypeScript-aware spellings and mean the same thing.
 */
const nodeFormat = (format: string | null | undefined): ModuleFormat | undefined => {
  switch (format) {
    case "module":
    case "module-typescript":
      return "module";
    case "commonjs":
    case "commonjs-typescript":
      return "commonjs";
    default:
      return undefined;
  }
};

/**
 * Format of a module Node gave no format for — resolved by our own
 * resolver, so Node never looked at it: the extension, then the nearest
 * `package.json#type`, memoized per directory.
 */
const packageTypes = new Map<string, ModuleFormat>();
const packageType = (directory: string): ModuleFormat => {
  let format = packageTypes.get(directory);
  if (format !== undefined) return format;
  const packageJson = path.join(directory, "package.json");
  const parent = path.dirname(directory);
  if (existsSync(packageJson)) {
    try {
      format =
        JSON.parse(readFileSync(packageJson, "utf8")).type === "module" ? "module" : "commonjs";
    } catch {
      format = "commonjs";
    }
  } else {
    format = parent === directory ? "commonjs" : packageType(parent);
  }
  packageTypes.set(directory, format);
  return format;
};

const inferFormat = (filePath: string): ModuleFormat => {
  const extension = path.extname(filePath);
  if (extension === ".mts" || extension === ".mjs") return "module";
  if (extension === ".cts" || extension === ".cjs") return "commonjs";
  return packageType(path.dirname(filePath));
};

const language = (filePath: string): TransformOptions["lang"] => {
  switch (path.extname(filePath)) {
    case ".tsx":
      return "tsx";
    case ".ts":
    case ".mts":
    case ".cts":
      return "ts";
    case ".jsx":
      return "jsx";
    default:
      return "js";
  }
};

type SourceMap = NonNullable<ReturnType<typeof transformSync>["map"]>;

/**
 * Whether a debugger can be attached to this process. Checked per module, so
 * an inspector opened after startup (VS Code auto-attach, `SIGUSR1`,
 * `inspector.open()`) covers every module loaded from then on.
 */
const isInspectorActive = () => inspector.url() !== undefined;

const inlineSourceMapComment = (map: string) =>
  `\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(map).toString("base64")}`;

/**
 * Map by reference. Node's source-map support only understands `data:`
 * URLs and scheme-less paths (it resolves the latter against the module
 * URL and reads the file), so this is the file URL's path component —
 * `/var/…/x.map` on POSIX, `/C:/…/x.map` on Windows — never a `file:` URL.
 */
const fileSourceMapComment = (mapFile: string) =>
  `\n//# sourceMappingURL=${pathToFileURL(mapFile).pathname}`;

/**
 * The map as stored: `sources` names the file by URL and `sourcesContent`
 * is dropped. A bare path in `sources` is resolved against the map's own
 * location, which for a cached map is the shared cache directory — a URL
 * is location-independent and correct on Windows too. Every source is a
 * file on this machine, so embedding its text only makes the map larger
 * than the code it describes and every process that loads the module pay
 * for it.
 */
const storedSourceMap = (
  { sourcesContent: _sourcesContent, ...map }: SourceMap,
  filePath: string,
): string => JSON.stringify({ ...map, sources: [pathToFileURL(filePath).href] });

/**
 * The map as a debugger needs it: inline, with the source embedded. A map
 * referenced by path sits in the shared cache directory, which debuggers
 * either refuse to read (VS Code only loads maps under the workspace by
 * default) or cannot fetch over the inspector protocol (DevTools), leaving
 * every module to show up as transpiled output from a foreign folder.
 */
const debuggerSourceMapComment = (map: string, source: string) =>
  inlineSourceMapComment(JSON.stringify({ ...JSON.parse(map), sourcesContent: [source] }));

/**
 * The module's source map comment. Inlined for a debugger, and when there
 * is no cache file to point at — the base64 becomes part of the script
 * source V8 retains for the process lifetime, which for a graph the size of
 * alchemy's is hundreds of megabytes, so it is never the default.
 */
const sourceMapComment = (
  map: string,
  mapFile: string | undefined,
  readSource: () => string,
): string => {
  if (isInspectorActive()) return debuggerSourceMapComment(map, readSource());
  return mapFile === undefined ? inlineSourceMapComment(map) : fileSourceMapComment(mapFile);
};

export interface TransformedSource {
  readonly format: ModuleFormat;
  readonly source: string;
}

export class SourceTransformer {
  readonly #options: OxcLoaderOptions;
  readonly #tsconfigCache = new TsconfigCache();
  readonly #cache: TransformCache | undefined;
  /**
   * Serialized merged tsconfig per discovered config chain. Discovery runs
   * per file (a solution-style tsconfig assigns files of one directory to
   * different referenced projects), but thousands of files share a chain
   * and the serialization is the expensive part of the key.
   */
  readonly #tsconfigKeys = new Map<string, string>();

  constructor(options: OxcLoaderOptions) {
    this.#options = options;
    const directory = resolveCacheDirectory(options.cache);
    this.#cache = directory === undefined ? undefined : new TransformCache(directory);
  }

  /**
   * Cache key for one transform, or `undefined` when the result must not be
   * cached. Every input Oxc's output depends on is part of it: the file's
   * path (source maps name it), its size and mtime standing in for its
   * contents — a stat instead of a read plus a hash per module on the warm
   * path — the effective transform options, Node's module format, and the
   * tsconfig that would be discovered for the file, resolved through the
   * same cache `transformSync` uses with the `extends` chain already
   * merged, so editing any tsconfig in the chain is a new key.
   */
  #cacheKey(filePath: string, options: TransformOptions, format: ModuleFormat): string | undefined {
    if (this.#cache === undefined) return undefined;
    let stat: { size: bigint; mtimeNs: bigint };
    try {
      stat = statSync(filePath, { bigint: true });
    } catch {
      return undefined;
    }
    let tsconfig = "null";
    try {
      if (options.tsconfig === true) {
        const resolved = resolveTsconfig(filePath, this.#tsconfigCache);
        if (resolved != null) {
          const chain = resolved.tsconfigFilePaths.join("\0");
          let serialized = this.#tsconfigKeys.get(chain);
          if (serialized === undefined) {
            serialized = JSON.stringify(resolved.tsconfig);
            this.#tsconfigKeys.set(chain, serialized);
          }
          tsconfig = serialized;
        }
      } else if (typeof options.tsconfig === "string") {
        tsconfig = readFileSync(options.tsconfig, "utf8");
      }
    } catch {
      // A broken tsconfig is the transform's error to report; don't cache.
      return undefined;
    }
    return this.#cache.key([
      filePath,
      `${stat.size}:${stat.mtimeNs}`,
      JSON.stringify(options),
      tsconfig,
      format,
    ]);
  }

  /**
   * Transpiles `filePath` for Node, or returns `undefined` when the file is
   * JavaScript that needs no work. `format` is what Node's `load` hook was
   * told; it decides `sourceType` and the format handed back.
   */
  transform(filePath: string, format: string | null | undefined): TransformedSource | undefined {
    const extension = path.extname(filePath);
    if (!transformExtensions.has(extension)) return undefined;

    let moduleFormat = nodeFormat(format) ?? inferFormat(filePath);
    const lang = language(filePath);
    const options: TransformOptions = {
      tsconfig: this.#options.tsconfig ?? true,
      sourcemap: true,
      lang,
    };
    // The key is taken before the source is read so a hit costs one stat
    // and one cache read, never the source itself.
    const key = this.#cacheKey(filePath, options, moduleFormat);
    const cached = key === undefined ? undefined : this.#cache?.get(key);
    if (cached !== undefined) {
      const { mapFile } = cached;
      return {
        format: cached.format,
        source:
          mapFile === undefined
            ? cached.code
            : isInspectorActive()
              ? cached.code +
                debuggerSourceMapComment(
                  readFileSync(mapFile, "utf8"),
                  readFileSync(filePath, "utf8"),
                )
              : cached.code + fileSourceMapComment(mapFile),
      };
    }
    const source = readFileSync(filePath, "utf8");
    // A `.ts` file in a CommonJS package that uses `import`/`export` runs
    // as ESM — the same call Node's own module-syntax detection makes for
    // `.js`. Explicit `.cts` stays CommonJS regardless.
    if (
      moduleFormat === "commonjs" &&
      extension !== ".cts" &&
      parseSync(filePath, source, { lang, sourceType: "unambiguous" }).module.hasModuleSyntax
    ) {
      moduleFormat = "module";
    }
    const transformed = transformSync(
      filePath,
      source,
      { ...options, sourceType: moduleFormat },
      this.#tsconfigCache,
    );
    if (transformed.errors.length > 0) {
      const [error] = transformed.errors;
      throw error instanceof Error
        ? error
        : new SyntaxError(
            `${filePath}: ${(error as { message?: string }).message ?? String(error)}`,
          );
    }
    const map =
      transformed.map === undefined ? undefined : storedSourceMap(transformed.map, filePath);
    // The map is stored next to the cache entry and referenced by path; see
    // `sourceMapComment` for when it is inlined instead.
    const mapFile =
      key === undefined || map === undefined
        ? undefined
        : this.#cache?.set(key, {
            format: moduleFormat,
            code: transformed.code,
            map,
          });
    return {
      format: moduleFormat,
      source:
        map === undefined
          ? transformed.code
          : transformed.code + sourceMapComment(map, mapFile, () => source),
    };
  }
}
