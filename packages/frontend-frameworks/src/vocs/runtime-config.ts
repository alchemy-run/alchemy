import type { Plugin } from "vite";

/**
 * Vite plugin for Vocs server builds that run as one bundled Fetch module
 * (Neon Functions, Azure Functions): no `vite` or `vocs.config.*` loader at
 * runtime. It keeps config imports and closures and removes only the
 * dev-only Vite loader: `Config.resolve()` returns the user config through
 * `virtual:alchemy-vocs/user-config`, and the MDX logger writes to the
 * console.
 */
export const vocsRuntimeConfigPlugin = (name: string): Plugin => ({
  name: `alchemy:vocs-${name}-runtime-config`,
  enforce: "post",
  transform(code, id) {
    const file = id.replaceAll("\\", "/").split("?")[0];
    if (file?.endsWith("/vocs/dist/internal/mdx.js")) {
      const logger =
        /const logger = createLogger\(undefined, \{ allowClearScreen: false, prefix: '\[vocs\]' \}\);/;
      if (!logger.test(code) || !code.includes("import { createLogger } from 'vite';"))
        throw new Error(`Vocs MDX logger changed; update the ${name} runtime bridge.`);
      return code
        .replace("import { createLogger } from 'vite';", "")
        .replace(
          logger,
          'const logger = { warn: (message) => console.warn("[vocs]", message), error: (message) => console.error("[vocs]", message) };',
        );
    }
    if (!file?.endsWith("/vocs/dist/internal/config.js")) return;
    const pattern =
      /export async function resolve\(options = \{\}\) \{[\s\S]*?\n\}\n(?=export let global;)/;
    if (!pattern.test(code))
      throw new Error(`Vocs runtime config shape changed; update the ${name} config bridge.`);
    return code.replace(
      pattern,
      "export async function resolve() {\n" +
        '  const resolved = (await import("virtual:alchemy-vocs/user-config")).default;\n' +
        "  return define(resolved);\n}\n",
    );
  },
});
