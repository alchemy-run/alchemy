import { existsSync, readFileSync } from "node:fs";
import path from "pathe";
import { loadEnv, type Plugin } from "vite";
import { defineConfig } from "vitest/config";

const AWS_API_GATEWAY_INCLUDE = "test/AWS/ApiGateway/**/*.test.ts";
const PLANETSCALE_INCLUDE = "test/Planetscale/**/*.test.ts";

export default defineConfig({
  plugins: [distilledSrcResolver()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
    },
  },
  test: {
    env: loadEnv("test", path.resolve(import.meta.dirname, "..", ".."), ""),
    pool: "forks",
    maxWorkers: 16,
    sequence: { concurrent: true },
    testTimeout: 120_000,
    hookTimeout: 120_000,
    passWithNoTests: true,
    projects: [
      // Run most tests with the above defaults, excluding special cases.
      {
        extends: true,
        test: {
          name: "default",
          include: ["test/**/*.test.ts"],
          exclude: [AWS_API_GATEWAY_INCLUDE, PLANETSCALE_INCLUDE],
        },
      },

      // AWS API Gateway has tight per-account rate limits (e.g.
      // DeleteRestApi allows 1 request per 30s). Run with extended
      // timeouts and no concurrency.
      {
        extends: true,
        test: {
          name: "aws/api-gateway",
          fileParallelism: false,
          sequence: { concurrent: false },
          testTimeout: 600_000,
          hookTimeout: 600_000,
          include: [AWS_API_GATEWAY_INCLUDE],
        },
      },

      // PlanetScale resources can take up to 20 minutes to provision;
      // run with extended timeouts.
      {
        extends: true,
        test: {
          name: "planetscale",
          testTimeout: 1_800_000,
          hookTimeout: 1_800_000,
          include: [PLANETSCALE_INCLUDE],
        },
      },
    ],
  },
});

/**
 * Resolve `@distilled.cloud/*` imports to their TypeScript sources so a
 * `bun scripts/generate.ts` regen is live in tests with no `lib` rebuild.
 *
 * The distilled packages expose `src/*.ts` under the `bun` export condition
 * and built `lib/*.js` under `default`. Under `bun vitest` the externalized
 * import would otherwise resolve `default` → stale `lib`. We can't flip the
 * resolver to `bun` globally (that breaks other deps' subpath resolution,
 * e.g. `@smithy/core`), so this plugin redirects ONLY `@distilled.cloud/*`
 * by reading each package's own `exports` map and picking its `bun` target.
 * Returning the absolute `src` path makes Vite transform it as a project
 * file instead of externalizing the built output.
 */
function distilledSrcResolver(): Plugin {
  const prefix = "@distilled.cloud/";
  const exportsCache = new Map<string, Record<string, any> | undefined>();

  const loadExports = (pkg: string) => {
    if (exportsCache.has(pkg)) return exportsCache.get(pkg);
    const pkgJson = path.resolve(
      import.meta.dirname,
      "node_modules",
      prefix + pkg,
      "package.json",
    );
    const exports = existsSync(pkgJson)
      ? (JSON.parse(readFileSync(pkgJson, "utf8")).exports as
          | Record<string, any>
          | undefined)
      : undefined;
    exportsCache.set(pkg, exports);
    return exports;
  };

  return {
    name: "distilled-src-resolver",
    enforce: "pre",
    resolveId(source) {
      if (!source.startsWith(prefix)) return null;
      const [pkg, ...rest] = source.slice(prefix.length).split("/");
      const exports = loadExports(pkg);
      if (!exports) return null;
      const subpath = rest.length ? `./${rest.join("/")}` : ".";

      // Exact match first, then the `./*` wildcard.
      let target = exports[subpath] as Record<string, string> | undefined;
      let star = "";
      if (!target && exports["./*"]) {
        target = exports["./*"];
        star = rest.join("/");
      }
      const file = target?.bun ?? target?.default;
      if (!file) return null;

      return path.resolve(
        import.meta.dirname,
        "node_modules",
        prefix + pkg,
        file.replace("*", star),
      );
    },
  };
}
