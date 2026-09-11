import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { resolveTsconfig } from "rolldown/experimental";
import {
  parseSync,
  transformSync,
  TsconfigCache,
  type TransformOptions,
} from "rolldown/utils";
import type { ImportLoaderOptions, TransformContext } from "./import-loader.ts";
import { resolveCacheDirectory, TransformCache } from "./transform-cache.ts";

/** Extensions Oxc transpiles; everything else is JavaScript Node can run. */
export const transformExtensions = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".jsx",
]);

export type ModuleFormat = "module" | "commonjs";

/**
 * Module format from Node's `load` hook context. Node derives these from the
 * extension and the nearest `package.json#type`; `*-typescript` variants are
 * its TypeScript-aware spellings and mean the same thing.
 */
const nodeFormat = (
  format: string | null | undefined,
): ModuleFormat | undefined => {
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

/** Fallback for older Nodes that pass no format: extension, then package type. */
const inferFormat = (filePath: string): ModuleFormat => {
  const extension = path.extname(filePath);
  if (extension === ".mts" || extension === ".mjs") return "module";
  if (extension === ".cts" || extension === ".cjs") return "commonjs";
  let directory = path.dirname(filePath);
  while (true) {
    const packageJson = path.join(directory, "package.json");
    if (existsSync(packageJson)) {
      try {
        return JSON.parse(readFileSync(packageJson, "utf8")).type === "module"
          ? "module"
          : "commonjs";
      } catch {
        return "commonjs";
      }
    }
    const parent = path.dirname(directory);
    if (parent === directory) return "commonjs";
    directory = parent;
  }
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

/**
 * Inline map, for when there is no cache file to point at. Only the
 * fallback: the base64 becomes part of the script source V8 retains, and
 * for a non-ASCII source it is stored two bytes per character on top.
 */
const inlineSourceMapComment = (map: string | object) => {
  const json = typeof map === "string" ? map : JSON.stringify(map);
  return `\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(json).toString("base64")}`;
};

/**
 * Map by reference. Node's source-map support only understands `data:`
 * URLs and scheme-less paths (it resolves the latter against the module
 * URL and reads the file), so this is the file URL's path component —
 * `/var/…/x.map` on POSIX, `/C:/…/x.map` on Windows — never a `file:` URL.
 */
const fileSourceMapComment = (mapFile: string) =>
  `\n//# sourceMappingURL=${pathToFileURL(mapFile).pathname}`;

/**
 * The transform's map without `sourcesContent`. Every source is a file on
 * this machine, named by the map's `sources`, so embedding its text only
 * makes the map larger than the code it describes and every process that
 * loads the module pay for it.
 */
const withoutSourcesContent = ({
  sourcesContent: _,
  ...map
}: NonNullable<ReturnType<typeof transformSync>["map"]>) => map;

export interface TransformedSource {
  readonly format: ModuleFormat;
  readonly source: string;
}

export class SourceTransformer {
  readonly #options: ImportLoaderOptions;
  readonly #tsconfigCache = new TsconfigCache();
  readonly #cache: TransformCache | undefined;

  constructor(options: ImportLoaderOptions) {
    this.#options = options;
    const directory = resolveCacheDirectory(options.cache);
    this.#cache =
      directory === undefined ? undefined : new TransformCache(directory);
  }

  /**
   * Cache key for one transform, or `undefined` when the result must not be
   * cached. Every input Oxc's output depends on is part of it: the source
   * and its path (source maps name it), the effective transform options,
   * Node's module format, and the tsconfig that would be discovered for the
   * file — resolved through the same cache `transformSync` uses, with the
   * `extends` chain already merged, so editing any tsconfig in the chain is
   * a new key.
   */
  #cacheKey(
    filePath: string,
    source: string,
    options: TransformOptions,
    format: ModuleFormat,
  ): string | undefined {
    if (this.#cache === undefined) return undefined;
    let tsconfig: unknown = null;
    try {
      if (options.tsconfig === true) {
        tsconfig = resolveTsconfig(filePath, this.#tsconfigCache)?.tsconfig;
      } else if (typeof options.tsconfig === "string") {
        tsconfig = readFileSync(options.tsconfig, "utf8");
      }
    } catch {
      // A broken tsconfig is the transform's error to report; don't cache.
      return undefined;
    }
    return this.#cache.key([
      filePath,
      source,
      JSON.stringify(options),
      JSON.stringify(tsconfig ?? null),
      format,
    ]);
  }

  /**
   * Transpiles `filePath` for Node, or returns `undefined` when the file is
   * JavaScript that needs no work. `format` is what Node's `load` hook was
   * told; it decides `sourceType` and the format handed back.
   */
  transform(
    filePath: string,
    url: string,
    format: string | null | undefined,
  ): TransformedSource | undefined {
    const extension = path.extname(filePath);
    const transpile = transformExtensions.has(extension);
    if (!transpile && this.#options.transforms === undefined) return undefined;

    let moduleFormat = nodeFormat(format) ?? inferFormat(filePath);
    let source = readFileSync(filePath, "utf8");
    // Exactly one of these ends up in the module: a map on disk to point
    // at, or (cache off, or a user transform's own map) one to inline.
    let mapFile: string | undefined;
    let map: string | object | undefined;
    if (transpile) {
      const lang = this.#options.transform?.lang ?? language(filePath);
      const options: TransformOptions = {
        tsconfig: this.#options.tsconfig ?? true,
        sourcemap: true,
        ...this.#options.transform,
        lang,
      };
      const key = this.#cacheKey(filePath, source, options, moduleFormat);
      const cached = key === undefined ? undefined : this.#cache?.get(key);
      if (cached !== undefined) {
        moduleFormat = cached.format;
        source = cached.code;
        mapFile = cached.mapFile;
      } else {
        // A `.ts` file in a CommonJS package that uses `import`/`export` runs
        // as ESM — the same call Node's own module-syntax detection makes for
        // `.js`. Explicit `.cts` stays CommonJS regardless.
        if (
          moduleFormat === "commonjs" &&
          extension !== ".cts" &&
          parseSync(filePath, source, { lang, sourceType: "unambiguous" })
            .module.hasModuleSyntax
        ) {
          moduleFormat = "module";
        }
        const transformed = transformSync(
          filePath,
          source,
          {
            ...options,
            sourceType: this.#options.transform?.sourceType ?? moduleFormat,
          },
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
        source = transformed.code;
        map =
          transformed.map === undefined
            ? undefined
            : JSON.stringify(withoutSourcesContent(transformed.map));
        if (key !== undefined) {
          mapFile = this.#cache?.set(key, {
            format: moduleFormat,
            code: source,
            map,
          });
          if (mapFile !== undefined) map = undefined;
        }
      }
    }

    const context: TransformContext = {
      url,
      path: filePath,
      format: moduleFormat,
    };
    for (const transform of this.#options.transforms ?? []) {
      const result = transform(source, context);
      if (typeof result === "string") {
        source = result;
        map = undefined;
        mapFile = undefined;
      } else if (result !== undefined) {
        source = result.code;
        map = result.map;
        mapFile = undefined;
      }
    }
    if (mapFile !== undefined) source += fileSourceMapComment(mapFile);
    else if (map !== undefined) source += inlineSourceMapComment(map);
    return { format: moduleFormat, source };
  }
}
