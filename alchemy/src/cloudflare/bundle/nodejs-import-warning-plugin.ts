import type { Plugin, PluginBuild } from "esbuild";
import kleur from "kleur";
import { logger } from "../../util/logger.ts";

export interface NodeJsImportWarningPluginOptions {
  compatibilityFlags: string[];
  compatibilityDate: string;
}

/**
 * ESBuild plugin to detect node:* imports and warn about missing compatibility flags.
 *
 * This plugin warns when:
 * - Any node:* import is found without nodejs_compat flag
 * - node:async_hooks is imported without nodejs_compat or nodejs_als flags
 */
export function nodeJsImportWarningPlugin(
  options: NodeJsImportWarningPluginOptions,
): Plugin {
  const { compatibilityFlags } = options;

  const hasNodejsCompat = compatibilityFlags.includes("nodejs_compat");
  const hasNodejsCompatV2 = compatibilityFlags.includes("nodejs_compat_v2");
  const hasNodejsAls = compatibilityFlags.includes("nodejs_als");

  // Consider nodejs_compat enabled if either flag is present or v2 with recent date
  const hasAnyNodejsCompat = hasNodejsCompat || hasNodejsCompatV2;

  return {
    name: "nodejs-import-warning",
    setup(build: PluginBuild) {
      const detectedImports = new Set<string>();

      build.onStart(() => {
        detectedImports.clear();
      });

      // Intercept resolution of node:* imports to detect them
      build.onResolve({ filter: /^node:/ }, (args) => {
        detectedImports.add(args.path);

        // Let the resolution continue normally
        return null;
      });

      build.onEnd(() => {
        if (detectedImports.size === 0) {
          return;
        }

        const warnings: string[] = [];
        const nodeAsyncHooksImported = detectedImports.has("node:async_hooks");

        // Check for general node:* imports without nodejs_compat
        if (!hasAnyNodejsCompat) {
          const importList = Array.from(detectedImports).sort();
          const useColor = !process.env.NO_COLOR;
          const formattedImports = importList
            .map((imp) => (useColor ? kleur.yellow(imp) : imp))
            .join(", ");

          warnings.push(
            `Detected Node.js imports (${formattedImports}) but ${useColor ? kleur.red("nodejs_compat") : "nodejs_compat"} compatibility flag is not set. ` +
              `Add ${useColor ? kleur.blue("nodejs_compat") : "nodejs_compat"} to your compatibility flags and ensure compatibilityDate >= 2024-09-23.`,
          );
        }

        // Special check for node:async_hooks requiring nodejs_compat or nodejs_als
        if (nodeAsyncHooksImported && !hasAnyNodejsCompat && !hasNodejsAls) {
          const useColor = !process.env.NO_COLOR;
          warnings.push(
            `Detected ${useColor ? kleur.yellow("node:async_hooks") : "node:async_hooks"} import but neither ` +
              `${useColor ? kleur.red("nodejs_compat") : "nodejs_compat"} nor ${useColor ? kleur.red("nodejs_als") : "nodejs_als"} ` +
              "compatibility flags are set. Add one of these flags to enable async hooks support.",
          );
        }

        // Log all warnings
        for (const warning of warnings) {
          logger.warn(warning);
        }
      });
    },
  };
}
