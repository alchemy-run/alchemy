import fs from "node:fs/promises";
import path from "pathe";
import { loadEnv } from "vite";
import { defineConfig, type Plugin } from "vitest/config";

const AWS_API_GATEWAY_INCLUDE = "test/AWS/ApiGateway/**/*.test.ts";
const PLANETSCALE_INCLUDE = "test/Planetscale/**/*.test.ts";

export default defineConfig({
  plugins: [
    bunExportConditionPlugin({
      include: /^@distilled\.cloud\/.*/,
    }),
  ],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
    },
  },
  test: {
    env: loadEnv("test", path.resolve(import.meta.dirname, "..", ".."), ""),
    pool: "forks",
    maxWorkers: 32,
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
 * Resolve raw TypeScript using the Bun export condition for selected packages.
 */
function bunExportConditionPlugin(filterId: {
  include?: RegExp[] | RegExp;
  exclude?: RegExp[] | RegExp;
}): Plugin {
  interface PackageJson {
    name: string;
    exports: Record<string, string | Record<string, string>>;
  }

  const findPackageJson = memoize(
    async (
      directory: string,
    ): Promise<
      { dir: string; pkg: PackageJson } | { dir: undefined; pkg: undefined }
    > => {
      const pkg = await fs
        .readFile(path.join(directory, "package.json"), { encoding: "utf8" })
        .then((content) => JSON.parse(content) as PackageJson)
        .catch(() => undefined);
      if (pkg) return { dir: directory, pkg };
      const parent = path.dirname(directory);
      if (parent === directory) return { dir: undefined, pkg: undefined };
      return await findPackageJson(parent);
    },
  );

  const hasBunExport = <K extends string>(
    exports: PackageJson["exports"],
    key: K,
  ): exports is { [k in K]: { bun: string } } =>
    key in exports && typeof exports[key] === "object" && "bun" in exports[key];

  const resolveBunExportId = memoize(
    async (resolvedId: string, source: string) => {
      const { pkg, dir } = await findPackageJson(path.dirname(resolvedId));
      if (!pkg) return undefined;
      // 1. Handle index exports
      if (pkg.name === source) {
        return hasBunExport(pkg.exports, ".")
          ? path.resolve(dir, pkg.exports["."].bun)
          : undefined;
      }
      // 2. Handle named exports
      const subpath = source.replace(`${pkg.name}/`, "");
      if (hasBunExport(pkg.exports, `./${subpath}`)) {
        return path.resolve(dir, pkg.exports[`./${subpath}`].bun);
      }
      // 3. Handle wildcard exports
      if (hasBunExport(pkg.exports, "./*")) {
        return path.resolve(dir, pkg.exports["./*"].bun.replace("*", subpath));
      }
      return undefined;
    },
  );

  return {
    name: "bun-export-condition",
    enforce: "pre",
    resolveId: {
      filter: { id: filterId },
      async handler(source, importer, options) {
        const resolved = await this.resolve(source, importer, options);
        if (resolved) {
          const id = await resolveBunExportId(resolved.id, source);
          if (id) return { id, moduleSideEffects: resolved.moduleSideEffects };
        }
        return resolved;
      },
    },
  };
}

/**
 * Memoize a function using a simple key-based cache.
 */
function memoize<I extends string[], O>(
  fn: (...input: I) => Promise<O>,
): (...input: I) => Promise<O> {
  const cache = new Map<string, Promise<O>>();
  return (...input: I) => {
    const key = input.join(":");
    const cached = cache.get(key);
    if (cached) return cached;
    const result = fn(...input);
    cache.set(key, result);
    return result;
  };
}
