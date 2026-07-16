import MagicString from "magic-string";
import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import path from "node:path";
import type {
  Plugin,
  PluginContext,
  RenderedChunk,
  RolldownMagicString,
  SourceMap,
} from "rolldown";
import { createPlugin } from "../factory.js";
import { sanitizePath, toPosixPath } from "../utils.js";

export const MODULE_RULES = [
  { type: "CompiledWasm", pattern: /\.wasm(\?module)?$/ },
  { type: "Data", pattern: /\.bin$/ },
  { type: "Text", pattern: /\.(txt|html|sql)$/ },
] as const;

const MODULE_REFERENCE_PATTERN = `__CLOUDFLARE_MODULE__(${MODULE_RULES.map((rule) => rule.type).join("|")})__(.*?)__CLOUDFLARE_MODULE__`;
const MODULE_REFERENCE_REGEX = new RegExp(MODULE_REFERENCE_PATTERN);
const MODULE_REFERENCE_GLOBAL_REGEX = new RegExp(MODULE_REFERENCE_PATTERN, "g");

// Matches the virtual IDs that `resolveId` produces (e.g.
// `__CLOUDFLARE_MODULE__CompiledWasm__/Users/.../foo.wasm__CLOUDFLARE_MODULE__`).
const MODULE_REFERENCE_ID_REGEX = new RegExp(`^${MODULE_REFERENCE_PATTERN}$`);

export const additionalModulesPlugin = createPlugin("additional-modules", () => {
  const additionalModulePaths = new Set<string>();
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
        filter: { id: MODULE_RULES.map((rule) => rule.pattern) },
        async handler(source, importer, options) {
          const resolved = await this.resolve(source, importer, options);
          if (!resolved) {
            return;
          }

          const rule = MODULE_RULES.find((rule) => rule.pattern.test(resolved.id));
          if (!rule) {
            return resolved;
          }

          const filePath = sanitizePath(resolved.id);
          additionalModulePaths.add(filePath);

          return {
            id: moduleReferenceId(rule.type, filePath),
            external: true,
          };
        },
      },
      // In dev mode (no `renderChunk`), vite's Node-side SSR runner
      // resolves then tries to load the virtual IDs we produce above.
      // The URL is just a marker — the file at that path is a real
      // `.wasm` / `.bin` / text file — so we read it HERE (in the
      // plugin, in the Vite Node main process) and inline its contents
      // as a base64 string literal in the returned module source.
      //
      // The consumer code runs inside `new AsyncFunction(...)` where
      // top-level `import` statements are illegal, so the returned
      // source contains no `import`s — just a `Buffer.from(b64, 'base64')`
      // expression that produces the original binary.
      load: {
        filter: { id: MODULE_REFERENCE_ID_REGEX },
        handler(id) {
          const match = MODULE_REFERENCE_ID_REGEX.exec(id);
          if (!match) return null;
          const type = match[1];
          const filePath = match[2];

          let bytes: Buffer;
          try {
            bytes = readFileSync(filePath);
          } catch {
            return null;
          }

          const b64 = bytes.toString("base64");
          if (type === "CompiledWasm") {
            return [
              `const __b64 = ${JSON.stringify(b64)};`,
              `const __bin = Buffer.from(__b64, 'base64');`,
              `export default __bin;`,
            ].join("\n");
          }
          if (type === "Text") {
            return [
              `const __b64 = ${JSON.stringify(b64)};`,
              `export default Buffer.from(__b64, 'base64').toString('utf8');`,
            ].join("\n");
          }
          // Data: raw bytes as base64.
          return `export default ${JSON.stringify(b64)};`;
        },
      },
      renderChunk: {
        filter: { code: { include: MODULE_REFERENCE_REGEX } },
        handler: withMagicString(async function (code, chunk, magicString) {
          const matches = code.matchAll(MODULE_REFERENCE_GLOBAL_REGEX);
          for (const match of matches) {
            const [full, , id] = match;
            const source = await this.fs.readFile(id);
            const referenceId = this.emitFile({
              type: "asset",
              name: path.basename(id),
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

function moduleReferenceId(type: "CompiledWasm" | "Data" | "Text", id: string) {
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
