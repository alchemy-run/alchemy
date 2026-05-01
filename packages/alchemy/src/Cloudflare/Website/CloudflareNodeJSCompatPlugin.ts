// ---------------------------------------------------------------------------
// Cloudflare hybrid Node.js-compat esbuild plugin (vendored).
//
// Vendored from cloudflare/workers-sdk:
//   packages/wrangler/src/deployment-bundle/esbuild-plugins/hybrid-nodejs-compat.ts
//   <https://github.com/cloudflare/workers-sdk/blob/wrangler%404.87.0/packages/wrangler/src/deployment-bundle/esbuild-plugins/hybrid-nodejs-compat.ts>
//
// License: MIT OR Apache-2.0 (same as alchemy's Apache-2.0 license).
//
// This plugin is what wrangler's internal `bundleWorker` installs when
// `nodejs_compat` (v2/hybrid) is active. It:
//
//   • Converts `require("node:X")` calls → ESM `import` shims so the
//     emitted `.mjs` bundle never references the (undefined) `require`
//     global at runtime under `nodejs_compat`.
//   • Routes unenv-aliased packages (e.g. `crypto` → unenv's shim) to
//     the resolved alias and respects the `external` set.
//   • Injects Node.js globals (`Buffer`, `process`, …) via virtual
//     modules that assign to `globalThis`.
//
// Wrangler does not export `bundleWorker` (or this plugin) from its npm
// package — the only public exports are `unstable_*` / `experimental_*`
// helpers (`unstable_dev`, `getPlatformProxy`, …) — so re-implementing
// the plugin against the publicly-exported `unenv` and
// `@cloudflare/unenv-preset` packages is the only programmatic way to
// reproduce the same bundle shape without spawning the wrangler CLI.
//
// Keep this file in sync with upstream when bumping the
// `@cloudflare/unenv-preset` and `unenv` versions.
// ---------------------------------------------------------------------------

import {
  getCloudflarePreset,
  nonPrefixedNodeModules,
} from "@cloudflare/unenv-preset";
import type { Plugin } from "esbuild";
import { createRequire } from "node:module";
import * as path from "node:path";
import { defineEnv } from "unenv";

const require = createRequire(import.meta.url);

const REQUIRED_NODE_BUILT_IN_NAMESPACE = "node-built-in-modules";
const REQUIRED_UNENV_ALIAS_NAMESPACE = "required-unenv-alias";

export interface CloudflareNodeJSCompatPluginOptions {
  /** workerd compatibility date (e.g. "2026-03-17"). */
  compatibilityDate?: string;
  /** workerd compatibility flags (must include "nodejs_compat"). */
  compatibilityFlags: string[];
}

export const cloudflareNodeJSCompatPlugin = ({
  compatibilityDate,
  compatibilityFlags,
}: CloudflareNodeJSCompatPluginOptions): Plugin => ({
  name: "alchemy:cloudflare-nodejs-compat",
  setup(build) {
    const { alias, inject, external, polyfill } = defineEnv({
      presets: [
        getCloudflarePreset({ compatibilityDate, compatibilityFlags }),
        // Force esbuild to use the real `debug` package instead of
        // unenv's no-op stub. Matches wrangler.
        { alias: { debug: "debug" } },
      ],
      npmShims: true,
    }).env;

    const nodeJsModuleRegexp = new RegExp(
      `^(${nonPrefixedNodeModules.join("|")}|node:.+)$`,
    );

    // Convert `require("node:X")` calls into ESM-compatible shims.
    build.onResolve({ filter: nodeJsModuleRegexp }, (args) => {
      if (args.kind === "require-call") {
        return { path: args.path, namespace: REQUIRED_NODE_BUILT_IN_NAMESPACE };
      }
      return null;
    });
    build.onLoad(
      { filter: /.*/, namespace: REQUIRED_NODE_BUILT_IN_NAMESPACE },
      ({ path: p }) => ({
        contents:
          `import libDefault from ${JSON.stringify(p)};\n` +
          `module.exports = libDefault;\n`,
        loader: "js",
      }),
    );

    // Resolve unenv-aliased packages to their resolved on-disk path,
    // respecting the `external` set.
    const aliasAbsolute: Record<string, string> = {};
    for (const [mod, unresolvedAlias] of Object.entries(alias)) {
      try {
        aliasAbsolute[mod] = require.resolve(unresolvedAlias);
      } catch {
        // some aliases (e.g. ones provided as virtual modules) won't
        // resolve from disk; that's fine — they'll be handled by
        // esbuild's normal resolution path.
      }
    }
    const aliasKeys = Object.keys(aliasAbsolute);
    if (aliasKeys.length > 0) {
      const UNENV_ALIAS_RE = new RegExp(`^(${aliasKeys.join("|")})$`);
      build.onResolve({ filter: UNENV_ALIAS_RE }, (args) => {
        const unresolvedAlias = alias[args.path];
        if (
          args.kind === "require-call" &&
          (unresolvedAlias.startsWith("unenv/npm/") ||
            unresolvedAlias.startsWith("unenv/mock/"))
        ) {
          return {
            path: args.path,
            namespace: REQUIRED_UNENV_ALIAS_NAMESPACE,
          };
        }
        return {
          path: aliasAbsolute[args.path],
          external: external.includes(unresolvedAlias),
        };
      });
      build.onLoad(
        { filter: /.*/, namespace: REQUIRED_UNENV_ALIAS_NAMESPACE },
        ({ path: p }) => ({
          contents:
            `import * as esm from ${JSON.stringify(p)};\n` +
            `module.exports = Object.entries(esm)\n` +
            `  .filter(([k]) => k !== "default")\n` +
            `  .reduce(\n` +
            `    (cjs, [k, value]) =>\n` +
            `      Object.defineProperty(cjs, k, { value, enumerable: true }),\n` +
            `    "default" in esm ? esm.default : {},\n` +
            `  );\n`,
          loader: "js",
        }),
      );
    }

    // Inject Node.js globals (`Buffer`, `process`, …) via virtual modules.
    const UNENV_VIRTUAL_MODULE_RE = /_virtual_unenv_global_polyfill-(.+)$/;
    const prefix = path.resolve(
      process.cwd(),
      "_virtual_unenv_global_polyfill-",
    );
    const injectsByModule = new Map<
      string,
      { injectedName: string; exportName: string; importName: string }[]
    >();
    const virtualPathToSpecifier = new Map<string, string>();
    for (const [injectedName, moduleSpecifier] of Object.entries(inject)) {
      const [mod, exportName, importName] = Array.isArray(moduleSpecifier)
        ? [moduleSpecifier[0], moduleSpecifier[1], moduleSpecifier[1]]
        : [moduleSpecifier, "default", "defaultExport"];
      let entries = injectsByModule.get(mod);
      if (!entries) {
        entries = [];
        injectsByModule.set(mod, entries);
        virtualPathToSpecifier.set(prefix + mod.replaceAll("/", "-"), mod);
      }
      entries.push({ injectedName, exportName, importName });
    }
    build.initialOptions.inject = [
      ...(build.initialOptions.inject ?? []),
      ...virtualPathToSpecifier.keys(),
      ...polyfill.map((m) => require.resolve(m)),
    ];
    build.onResolve({ filter: UNENV_VIRTUAL_MODULE_RE }, ({ path: p }) => ({
      path: p,
    }));
    build.onLoad({ filter: UNENV_VIRTUAL_MODULE_RE }, ({ path: p }) => {
      const mod = virtualPathToSpecifier.get(p)!;
      const injects = injectsByModule.get(mod)!;
      const imports = injects.map(({ exportName, importName }) =>
        importName === exportName ? exportName : `${exportName} as ${importName}`,
      );
      return {
        contents:
          `import { ${imports.join(", ")} } from ${JSON.stringify(mod)};\n` +
          injects
            .map(
              ({ injectedName, importName }) =>
                `globalThis.${injectedName} = ${importName};`,
            )
            .join("\n"),
      };
    });
  },
});
