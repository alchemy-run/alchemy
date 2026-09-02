import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  transformSync,
  TsconfigCache,
  type TransformOptions,
} from "rolldown/utils";
import type { ImportLoaderOptions, TransformContext } from "./import-loader.ts";

export const transformExtensions = new Set([".ts", ".tsx", ".mts", ".cts"]);

export const typeScriptSpecifier = (specifier: string): string | undefined => {
  const metadataIndex = specifier.search(/[?#]/);
  const path =
    metadataIndex === -1 ? specifier : specifier.slice(0, metadataIndex);
  const metadata = metadataIndex === -1 ? "" : specifier.slice(metadataIndex);
  if (path.endsWith(".js")) return `${path.slice(0, -3)}.ts${metadata}`;
  if (path.endsWith(".jsx")) return `${path.slice(0, -4)}.tsx${metadata}`;
  if (path.endsWith(".mjs")) return `${path.slice(0, -4)}.mts${metadata}`;
  if (path.endsWith(".cjs")) return `${path.slice(0, -4)}.cts${metadata}`;
  return undefined;
};

const moduleFormat = (filePath: string): "module" | "commonjs" => {
  const extension = path.extname(filePath);
  if (
    extension === ".ts" ||
    extension === ".tsx" ||
    extension === ".mts" ||
    extension === ".mjs"
  ) {
    return "module";
  }
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

const sourceMapComment = (map: string | object) => {
  const json = typeof map === "string" ? map : JSON.stringify(map);
  return `\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(json).toString("base64")}`;
};

export class SourceTransformer {
  readonly #options: ImportLoaderOptions;
  readonly #tsconfigCache = new TsconfigCache();

  constructor(options: ImportLoaderOptions) {
    this.#options = options;
  }

  transform(
    filePath: string,
    url: string,
  ):
    | { readonly format: "module" | "commonjs"; readonly source: string }
    | undefined {
    const extension = path.extname(filePath);
    if (
      !transformExtensions.has(extension) &&
      this.#options.transforms === undefined
    ) {
      return undefined;
    }

    const format = moduleFormat(filePath);
    let source = readFileSync(filePath, "utf8");
    let map: string | object | undefined;
    if (transformExtensions.has(extension)) {
      const transformed = transformSync(
        filePath,
        source,
        {
          tsconfig: true,
          sourcemap: true,
          ...this.#options.transform,
          lang: this.#options.transform?.lang ?? language(filePath),
          sourceType: this.#options.transform?.sourceType ?? format,
        },
        this.#tsconfigCache,
      );
      if (transformed.errors.length > 0) throw transformed.errors[0];
      source = transformed.code;
      map = transformed.map;
    }

    const context: TransformContext = { url, path: filePath, format };
    for (const transform of this.#options.transforms ?? []) {
      const result = transform(source, context);
      if (typeof result === "string") {
        source = result;
        map = undefined;
      } else if (result !== undefined) {
        source = result.code;
        map = result.map;
      }
    }
    if (map !== undefined) source += sourceMapComment(map);
    return { format, source };
  }
}
