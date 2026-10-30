import { createHash } from "node:crypto";
import path from "node:path";
import MagicString from "magic-string";
import type {
  Plugin,
  PluginContext,
  RenderedChunk,
  RolldownMagicString,
  SourceMap,
} from "rolldown";
import { createPlugin } from "../factory.ts";
import { sanitizePath, toPosixPath } from "../utils.ts";

export const MODULE_RULES = [
  { type: "CompiledWasm", pattern: /\.wasm(\?module)?$/ },
  { type: "Data", pattern: /\.bin$/ },
  { type: "Text", pattern: /\.(txt|html|sql)$/ },
] as const;

const MODULE_REFERENCE_PATTERN = `__CLOUDFLARE_MODULE__(${MODULE_RULES.map((rule) => rule.type).join("|")})__(.*?)__CLOUDFLARE_MODULE__`;
export const MODULE_REFERENCE_REGEX = new RegExp(MODULE_REFERENCE_PATTERN);
const MODULE_REFERENCE_GLOBAL_REGEX = new RegExp(MODULE_REFERENCE_PATTERN, "g");

export const additionalModulesPlugin = createPlugin("additional-modules", (options) => {
  const additionalModulePaths = new Set<string>();
  const userRules = options.moduleRules ?? [];
  // Subpath imports (`#html`) resolve to a module type only once resolved,
  // as in `@cloudflare/vite-plugin`.
  const builtinFilter = [...MODULE_RULES.map((rule) => rule.pattern), /^#/];
  // Built-in rules see the same imports as without user rules. User rules
  // only claim plain imported files: entries, externals, virtual ids and
  // query imports (`?init`, `?raw`, ...) belong to other plugins.
  const matchType = (
    source: string,
    resolved: { id: string; external?: boolean | string },
    importer: string | undefined,
  ) => {
    const userRule =
      importer && !resolved.external && isPlainFile(resolved.id)
        ? userRules.find((rule) => rule.test(sanitizePath(resolved.id)))
        : undefined;
    if (userRule) {
      return userRule.type ?? typeFromExtension(resolved.id) ?? "Data";
    }
    return builtinFilter.some((pattern) => pattern.test(source))
      ? MODULE_RULES.find((rule) => rule.pattern.test(resolved.id))?.type
      : undefined;
  };
  return {
    vite: {
      enforce: "pre",
      hotUpdate(options) {
        if (additionalModulePaths.has(options.file)) {
          void options.server.restart();
          return [];
        }
      },
    },
    shared: {
      resolveId: {
        // User rules match the resolved path, so they can't narrow the filter.
        filter: userRules.length ? { id: { exclude: /^\0/ } } : { id: builtinFilter },
        async handler(source, importer, options) {
          const resolved = await this.resolve(source, importer, options);
          if (!resolved) {
            return;
          }

          const type = matchType(source, resolved, importer);
          if (!type) {
            return resolved;
          }

          const filePath = sanitizePath(resolved.id);
          additionalModulePaths.add(filePath);

          return {
            id: moduleReferenceId(type, filePath),
            external: true,
          };
        },
      },
      renderChunk: {
        filter: { code: { include: MODULE_REFERENCE_REGEX } },
        handler: withMagicString(async function (code, chunk, magicString) {
          const matches = code.matchAll(MODULE_REFERENCE_GLOBAL_REGEX);
          for (const match of matches) {
            const [full, type, id] = match as unknown as [string, ModuleType, string];
            const source = await this.fs.readFile(id);
            // An explicit file name keyed by type and content: rolldown merges
            // assets with identical bytes, which would give a Data import the
            // Text module of another file.
            const name = moduleFileName(type, path.basename(id));
            const ext = path.extname(name);
            const hash = createHash("sha256").update(type).update(source).digest("hex").slice(0, 8);
            const referenceId = this.emitFile({
              type: "asset",
              fileName: `assets/${name.slice(0, name.length - ext.length)}-${hash}${ext}`,
              source,
            });
            const fileName = this.getFileName(referenceId);
            const relativePath = toPosixPath(path.relative(path.dirname(chunk.fileName), fileName));
            const importPath = relativePath.startsWith(".") ? relativePath : `./${relativePath}`;
            magicString.update(match.index, match.index + full.length, importPath);
          }
        }),
      },
    },
  };
});

type ModuleType = (typeof MODULE_RULES)[number]["type"];

/** The module type the uploader infers from a file name, as Wrangler does. */
function typeFromExtension(name: string): ModuleType | undefined {
  return MODULE_RULES.find((rule) => rule.pattern.test(name))?.type;
}

/**
 * Uploads infer a module's type from its extension (unknown ones are Data),
 * so a file whose rule picks another type gets that type's extension.
 */
function moduleFileName(type: ModuleType, name: string) {
  const inferred = /\.([cm]?js|py|map)$/.test(name)
    ? undefined
    : name.endsWith(".custom")
      ? "Text"
      : (typeFromExtension(name) ?? "Data");
  if (inferred === type) return name;
  return `${name}${type === "Text" ? ".txt" : type === "Data" ? ".bin" : ".wasm"}`;
}

function isPlainFile(id: string) {
  return path.isAbsolute(id) && !/[?#]/.test(id.replace(/\?module$/, ""));
}

function moduleReferenceId(type: ModuleType, id: string) {
  return `__CLOUDFLARE_MODULE__${type}__${id}__CLOUDFLARE_MODULE__` as const;
}

type PluginHandler<T extends keyof Plugin> = Plugin[T] extends infer T
  ? T extends (...args: any) => any
    ? T
    : never
  : never;

/**
 * Returns a `renderChunk` handler that transforms the chunk using a magic string.
 * Uses Rolldown's native magic string if available, or the `magic-string` library otherwise.
 */
function withMagicString(
  renderChunk: (
    this: PluginContext,
    code: string,
    chunk: RenderedChunk,
    magicString: MagicString | RolldownMagicString,
  ) => Promise<void>,
): PluginHandler<"renderChunk"> {
  return async function (code, chunk, outputOptions, meta) {
    const magicString = meta.magicString ?? new MagicString(code);
    await renderChunk.call(this, code, chunk, magicString);
    if ("isRolldownMagicString" in magicString && magicString.isRolldownMagicString) {
      return magicString;
    }
    return {
      code: magicString.toString(),
      map: outputOptions.sourcemap
        ? (magicString.generateMap({ hires: "boundary" }) as SourceMap)
        : null,
    };
  };
}
