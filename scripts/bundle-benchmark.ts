#!/usr/bin/env bun
/**
 * Bundle benchmark comparing tree-shaking effectiveness across bundlers.
 *
 * Bundles examples/aws/src/JobFunction.ts with esbuild, rollup, rolldown,
 * webpack 5, and rspack, then compares output sizes (raw and gzip) to
 * determine which bundlers best tree-shake the effect + alchemy-effect
 * libraries.
 *
 * ## What is "deep scope analysis"?
 *
 * When you `import { Effect } from "effect"`, the barrel file re-exports
 * every module in the package. A bundler WITHOUT deep scope analysis sees
 * the re-exported namespace object is "used" and pulls in ALL of its
 * members. A bundler WITH deep scope analysis traces through the barrel
 * and into each namespace to determine which individual functions are
 * actually referenced, eliminating the rest.
 *
 * Rollup and Webpack 5+ support deep scope analysis. esbuild, rolldown,
 * and rspack have varying levels of support — this benchmark measures
 * the practical impact.
 *
 * The remaining tree-shaking question is whether the bundler can eliminate
 * unused *functions* from each individual module (e.g. the hundreds of
 * functions exported from `effect/Effect`).
 *
 * All bundlers resolve alchemy-effect via the "bun" export condition so
 * they read .ts source directly — no pre-build step required.
 *
 * Usage: bun scripts/bundle-benchmark.ts
 */

process.noDeprecation = true;

import {
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { builtinModules } from "node:module";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";

const ROOT = resolve(import.meta.dirname!, "..");
const ENTRY = resolve(ROOT, "examples/aws/src/JobFunction.ts");
const OUT_DIR = resolve(ROOT, ".bundle-benchmark");

const NODE_BUILTINS = new Set([
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
]);

/**
 * Only bundle effect ecosystem packages + alchemy-effect + local files.
 * Everything else (AWS SDK, native deps, etc.) is externalized.
 */
function isExternal(id: string): boolean {
  if (id.startsWith(".") || id.startsWith("/")) return false;
  if (NODE_BUILTINS.has(id)) return true;
  if (id.startsWith("node:")) return true;

  const parts = id.split("/");
  const pkgName = id.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];

  if (pkgName === "effect") return false;
  if (pkgName!.startsWith("@effect/")) return false;
  if (pkgName === "alchemy-effect") return false;

  return true;
}

// ─── Module analysis types ──────────────────────────────────────────────────

interface ModuleEntry {
  path: string;
  size: number;
}

type PackageGroup =
  | "effect"
  | "@effect/*"
  | "alchemy-effect"
  | "local"
  | "other";

const PACKAGE_GROUPS: PackageGroup[] = [
  "effect",
  "@effect/*",
  "alchemy-effect",
  "local",
  "other",
];

function categorizeModule(rawPath: string): PackageGroup {
  const p = rawPath.replace(/^\.\//, "");
  if (/(?:^|\/)node_modules\/effect\//.test(p) || p.startsWith("effect/"))
    return "effect";
  if (/(?:^|\/)node_modules\/@effect\//.test(p) || p.startsWith("@effect/"))
    return "@effect/*";
  if (/alchemy-effect\//.test(p)) return "alchemy-effect";
  if (/examples\//.test(p) || p.startsWith("src/")) return "local";
  return "other";
}

function shortModulePath(rawPath: string): string {
  const rel = rawPath.startsWith("/") ? relative(ROOT, rawPath) : rawPath;
  return rel
    .replace(/^\.\//, "")
    .replace(/^node_modules\//, "")
    .replace(/\/dist\/esm\//, "/")
    .replace(/\/dist\/cjs\//, "/")
    .replace(/\.(js|mjs|ts|tsx)$/, "");
}

function groupByPackage(modules: ModuleEntry[]): Record<PackageGroup, number> {
  const groups: Record<PackageGroup, number> = {
    effect: 0,
    "@effect/*": 0,
    "alchemy-effect": 0,
    local: 0,
    other: 0,
  };
  for (const m of modules) {
    groups[categorizeModule(m.path)] += m.size;
  }
  return groups;
}

// ─── Result types ───────────────────────────────────────────────────────────

interface BenchmarkResult {
  bundler: string;
  rawSize: number;
  gzipSize: number;
  durationMs: number;
  modules: ModuleEntry[];
  error?: string;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function measureFile(filePath: string): { rawSize: number; gzipSize: number } {
  const content = readFileSync(filePath);
  return { rawSize: content.length, gzipSize: gzipSync(content).length };
}

function measureDir(dirPath: string): { rawSize: number; gzipSize: number } {
  let rawSize = 0;
  let gzipSize = 0;
  for (const entry of readdirSync(dirPath, { recursive: true })) {
    const filePath = join(dirPath, entry.toString());
    try {
      const stat = statSync(filePath);
      if (stat.isFile() && filePath.endsWith(".js")) {
        const m = measureFile(filePath);
        rawSize += m.rawSize;
        gzipSize += m.gzipSize;
      }
    } catch {}
  }
  return { rawSize, gzipSize };
}

function listJsFiles(dirPath: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dirPath, { recursive: true })) {
    const filePath = join(dirPath, entry.toString());
    try {
      const stat = statSync(filePath);
      if (stat.isFile() && filePath.endsWith(".js")) {
        files.push(filePath);
      }
    } catch {}
  }
  return files;
}

function collectBareImports(code: string): Set<string> {
  const imports = new Set<string>();
  const fromRe =
    /(?:import|export)(?:[^"'`]*?from)?\s*["']([^./"'][^"']*)["']/g;
  const dynamicRe = /import\(\s*["']([^./"'][^"']*)["']\s*\)/g;

  for (const re of [fromRe, dynamicRe]) {
    let match: RegExpExecArray | null;
    while ((match = re.exec(code)) !== null) {
      imports.add(match[1]!);
    }
  }

  return imports;
}

function validateJsOutputs(dirPath: string): string | undefined {
  const files = listJsFiles(dirPath);
  if (files.length === 0) {
    return "No emitted JavaScript files found to validate";
  }

  for (const file of files) {
    const checked = spawnSync("node", ["--check", file], {
      cwd: ROOT,
      encoding: "utf8",
    });
    if (checked.status !== 0) {
      return (
        checked.stderr ||
        checked.stdout ||
        `Syntax check failed for ${relative(ROOT, file)}`
      );
    }
  }

  const bareImports = new Set<string>();
  for (const file of files) {
    const code = readFileSync(file, "utf8");
    for (const specifier of collectBareImports(code)) {
      bareImports.add(specifier);
    }
  }

  if (bareImports.size > 0) {
    return undefined;
  }

  for (const file of files) {
    const loaded = spawnSync(
      "node",
      [
        "--input-type=module",
        "-e",
        `await import(${JSON.stringify(pathToFileURL(file).href)});`,
      ],
      {
        cwd: ROOT,
        encoding: "utf8",
      },
    );
    if (loaded.status !== 0) {
      return (
        loaded.stderr ||
        loaded.stdout ||
        `Runtime import failed for ${relative(ROOT, file)}`
      );
    }
  }

  return undefined;
}

// ─── esbuild ────────────────────────────────────────────────────────────────

async function bundleEsbuild(): Promise<BenchmarkResult> {
  const esbuild = await import("esbuild");
  const outfile = join(OUT_DIR, "esbuild", "output.js");
  mkdirSync(join(OUT_DIR, "esbuild"), { recursive: true });

  const start = performance.now();
  const result = await esbuild.build({
    entryPoints: [ENTRY],
    bundle: true,
    minify: true,
    format: "esm",
    platform: "node",
    target: "node20",
    outfile,
    treeShaking: true,
    metafile: true,
    legalComments: "none",
    conditions: ["bun"],
    drop: ["debugger"],
    mainFields: ["module", "main"],
    plugins: [
      {
        name: "external-filter",
        setup(build) {
          build.onResolve({ filter: /^[^./]/ }, (args) => {
            if (isExternal(args.path)) {
              return { path: args.path, external: true };
            }
            return undefined;
          });
        },
      },
    ],
  });
  const durationMs = performance.now() - start;
  const { rawSize, gzipSize } = measureFile(outfile);

  const modules: ModuleEntry[] = [];
  const outKey = Object.keys(result.metafile!.outputs).find((k) =>
    k.endsWith("output.js"),
  );
  if (outKey) {
    for (const [path, info] of Object.entries(
      result.metafile!.outputs[outKey]!.inputs,
    )) {
      modules.push({ path, size: info.bytesInOutput });
    }
  }

  writeFileSync(
    join(OUT_DIR, "esbuild", "metafile.json"),
    JSON.stringify(result.metafile, null, 2),
  );

  return { bundler: "esbuild", rawSize, gzipSize, durationMs, modules };
}

// ─── rollup ─────────────────────────────────────────────────────────────────

async function bundleRollup(): Promise<BenchmarkResult> {
  const { rollup } = await import("rollup");
  const nodeResolve = (await import("@rollup/plugin-node-resolve")).default;
  const commonjs = (await import("@rollup/plugin-commonjs")).default;
  const esbuildPlugin = (await import("rollup-plugin-esbuild")).default;

  const outfile = join(OUT_DIR, "rollup", "output.js");
  mkdirSync(join(OUT_DIR, "rollup"), { recursive: true });

  const start = performance.now();
  const bundle = await rollup({
    input: ENTRY,
    external: (id) => isExternal(id),
    treeshake: {
      preset: "smallest",
    },
    plugins: [
      nodeResolve({
        extensions: [".ts", ".js", ".mjs"],
        exportConditions: ["bun", "import", "default"],
      }),
      commonjs(),
      esbuildPlugin({
        target: "node20",
        minify: true,
        tsconfig: resolve(ROOT, "examples/aws/tsconfig.json"),
      }),
    ],
    onwarn(warning, warn) {
      if (warning.code === "CIRCULAR_DEPENDENCY") return;
      if (warning.code === "THIS_IS_UNDEFINED") return;
      warn(warning);
    },
  });

  const { output } = await bundle.write({
    file: outfile,
    format: "esm",
    sourcemap: false,
  });
  await bundle.close();
  const durationMs = performance.now() - start;
  const { rawSize, gzipSize } = measureFile(outfile);

  // renderedLength is post-tree-shake, pre-minification
  const modules: ModuleEntry[] = [];
  for (const chunk of output) {
    if (chunk.type === "chunk" && chunk.modules) {
      for (const [path, info] of Object.entries(chunk.modules)) {
        modules.push({ path, size: info.renderedLength });
      }
    }
  }

  return { bundler: "rollup", rawSize, gzipSize, durationMs, modules };
}

// ─── rolldown ───────────────────────────────────────────────────────────────

async function bundleRolldown(): Promise<BenchmarkResult> {
  const { rolldown } = await import("rolldown");

  const outdir = join(OUT_DIR, "rolldown");
  mkdirSync(outdir, { recursive: true });

  const start = performance.now();
  const bundle = await rolldown({
    input: ENTRY,
    external: (id) => {
      if (typeof id === "string") return isExternal(id);
      return false;
    },
    treeshake: {
      moduleSideEffects: false,
      unknownGlobalSideEffects: false,
      propertyReadSideEffects: false,
      propertyWriteSideEffects: false,
    },
    resolve: {
      extensions: [".ts", ".js", ".mjs"],
      conditionNames: ["bun", "import", "default"],
    },
    optimization: {
      inlineConst: { mode: "all", pass: 3 },
    },
    experimental: {
      lazyBarrel: true,
    },
  });

  const { output } = await bundle.write({
    dir: outdir,
    format: "esm",
    sourcemap: false,
    externalLiveBindings: false,
    minify: {
      compress: {
        target: "es2022",
        maxIterations: 10,
        treeshake: {
          propertyReadSideEffects: false,
          unknownGlobalSideEffects: false,
        },
      },
      mangle: { toplevel: true },
    },
  });
  await bundle.close();
  const durationMs = performance.now() - start;
  const { rawSize, gzipSize } = measureDir(outdir);
  const modules: ModuleEntry[] = [];
  for (const chunk of output) {
    if (chunk.type === "chunk" && chunk.modules) {
      for (const [path, info] of Object.entries(chunk.modules)) {
        modules.push({ path, size: info.renderedLength });
      }
    }
  }

  const validationError = validateJsOutputs(outdir);
  if (validationError) {
    return {
      bundler: "rolldown",
      rawSize,
      gzipSize,
      durationMs,
      modules,
      error: validationError,
    };
  }

  return { bundler: "rolldown", rawSize, gzipSize, durationMs, modules };
}

// ─── rolldown + terser ──────────────────────────────────────────────────────

async function bundleRolldownTerser(): Promise<BenchmarkResult> {
  const { rolldown } = await import("rolldown");
  const { minify: terserMinify } = await import("terser");

  const outdir = join(OUT_DIR, "rolldown-terser");
  mkdirSync(outdir, { recursive: true });

  const start = performance.now();
  const bundle = await rolldown({
    input: ENTRY,
    external: (id) => {
      if (typeof id === "string") return isExternal(id);
      return false;
    },
    treeshake: {
      moduleSideEffects: false,
      unknownGlobalSideEffects: false,
      propertyReadSideEffects: false,
      propertyWriteSideEffects: false,
    },
    resolve: {
      extensions: [".ts", ".js", ".mjs"],
      conditionNames: ["bun", "import", "default"],
    },
    optimization: {
      inlineConst: { mode: "all", pass: 3 },
    },
    experimental: {
      lazyBarrel: true,
    },
  });

  const { output } = await bundle.generate({
    format: "esm",
    sourcemap: false,
    externalLiveBindings: false,
    minify: {
      compress: {
        target: "es2022",
        treeshake: {
          propertyReadSideEffects: false,
          unknownGlobalSideEffects: false,
        },
      },
      mangle: { toplevel: true },
    },
  });
  await bundle.close();

  const chunk = output.find((c) => c.type === "chunk")!;
  const terserResult = await terserMinify(chunk.code, {
    compress: {
      passes: 3,
      pure_getters: true,
      toplevel: true,
      unused: true,
      dead_code: true,
      side_effects: true,
    },
    mangle: { toplevel: true },
    module: true,
  });
  const outfile = join(outdir, chunk.fileName);
  writeFileSync(outfile, terserResult.code!);

  const durationMs = performance.now() - start;
  const { rawSize, gzipSize } = measureFile(outfile);
  const validationError = validateJsOutputs(outdir);
  if (validationError) {
    return {
      bundler: "rolldown+terser",
      rawSize,
      gzipSize,
      durationMs,
      modules: [],
      error: validationError,
    };
  }

  const modules: ModuleEntry[] = [];
  for (const c of output) {
    if (c.type === "chunk" && c.modules) {
      for (const [path, info] of Object.entries(c.modules)) {
        modules.push({ path, size: info.renderedLength });
      }
    }
  }

  return { bundler: "rolldown+terser", rawSize, gzipSize, durationMs, modules };
}

// ─── webpack 5 ──────────────────────────────────────────────────────────────

async function bundleWebpack(): Promise<BenchmarkResult> {
  const webpack = (await import("webpack")).default;
  const TerserPlugin = (await import("terser-webpack-plugin")).default;

  const outdir = join(OUT_DIR, "webpack");
  mkdirSync(outdir, { recursive: true });

  const start = performance.now();
  const keepAlive = setInterval(() => {}, 100);

  return new Promise<BenchmarkResult>((res) => {
    const compiler = webpack({
      entry: ENTRY,
      mode: "production",
      output: {
        path: outdir,
        filename: "output.js",
        library: { type: "module" },
        clean: true,
      },
      experiments: { outputModule: true },
      externalsType: "module",
      externals: [
        ({ request }: any, callback: any) => {
          if (request && isExternal(request)) {
            return callback(null, `module ${request}`);
          }
          callback();
        },
      ],
      module: {
        rules: [
          {
            test: /\.ts$/,
            loader: "esbuild-loader",
            options: { target: "node20" },
          },
        ],
      },
      resolve: {
        extensions: [".ts", ".js", ".mjs"],
        conditionNames: ["bun", "import", "module", "default"],
      },
      optimization: {
        minimize: true,
        minimizer: [
          new TerserPlugin({
            parallel: false,
            terserOptions: { compress: { passes: 2 } },
          }),
        ],
        usedExports: true,
        sideEffects: true,
        providedExports: true,
        innerGraph: true,
        concatenateModules: true,
        mangleExports: "size",
      },
    });

    compiler.run((err, stats) => {
      clearInterval(keepAlive);
      const durationMs = performance.now() - start;

      if (err || stats?.hasErrors()) {
        const msg =
          err?.message ||
          stats?.compilation.errors.map((e) => e.message).join("\n") ||
          "Unknown error";
        compiler.close(() => {});
        res({
          bundler: "webpack",
          rawSize: 0,
          gzipSize: 0,
          durationMs,
          modules: [],
          error: msg,
        });
        return;
      }

      const { rawSize, gzipSize } = measureFile(join(outdir, "output.js"));

      const modules: ModuleEntry[] = [];
      const json = stats!.toJson({ modules: true, assets: false });
      if (json.modules) {
        for (const mod of json.modules) {
          if (mod.name && mod.size != null) {
            modules.push({ path: mod.name, size: mod.size });
          }
        }
      }

      writeFileSync(join(outdir, "stats.json"), JSON.stringify(json, null, 2));

      compiler.close(() => {});
      res({ bundler: "webpack", rawSize, gzipSize, durationMs, modules });
    });
  });
}

// ─── rspack ─────────────────────────────────────────────────────────────────

async function bundleRspack(): Promise<BenchmarkResult> {
  const rspackPkg = await import("@rspack/core");
  const { rspack } = rspackPkg;

  const outdir = join(OUT_DIR, "rspack");
  mkdirSync(outdir, { recursive: true });

  const start = performance.now();
  const keepAlive = setInterval(() => {}, 100);

  const TerserPlugin = new (await import("terser-webpack-plugin")).default({
    parallel: false,
    terserOptions: { compress: { passes: 2 } },
  }) as any;

  return new Promise<BenchmarkResult>(async (res) => {
    const compiler = rspack({
      entry: ENTRY,
      mode: "production",
      output: {
        path: outdir,
        filename: "output.js",
        library: { type: "module" },
        clean: true,
      },
      experiments: { outputModule: true },
      externalsType: "module",
      externals: [
        ({ request }: any, callback: any) => {
          if (request && isExternal(request)) {
            return callback(null, `module ${request}`);
          }
          callback();
        },
      ],
      module: {
        rules: [
          {
            test: /\.ts$/,
            use: {
              loader: "builtin:swc-loader",
              options: {
                jsc: {
                  parser: { syntax: "typescript" },
                  target: "es2022",
                },
              },
            },
          },
        ],
      },
      resolve: {
        extensions: [".ts", ".js", ".mjs"],
        conditionNames: ["bun", "import", "module", "default"],
      },
      optimization: {
        minimize: true,
        minimizer: [
          new rspackPkg.rspack.SwcJsMinimizerRspackPlugin({
            minimizerOptions: {
              compress: {
                passes: 0,
                pure_getters: true,
                toplevel: true,
                reduce_funcs: true,
                hoist_props: true,
              },
              mangle: { toplevel: true },
              module: true,
              ecma: 2022,
            },
          }),
        ],
        usedExports: true,
        sideEffects: true,
        providedExports: true,
        innerGraph: true,
        concatenateModules: true,
        mangleExports: "size",
        avoidEntryIife: true,
      },
    });

    compiler.run((err, stats) => {
      clearInterval(keepAlive);
      const durationMs = performance.now() - start;

      if (err || stats?.hasErrors()) {
        const msg =
          err?.message ||
          stats?.compilation.errors
            .slice(0, 3)
            .map((e) => e.message)
            .join("\n") ||
          "Unknown error";
        compiler.close(() => {});
        res({
          bundler: "rspack",
          rawSize: 0,
          gzipSize: 0,
          durationMs,
          modules: [],
          error: msg,
        });
        return;
      }

      const { rawSize, gzipSize } = measureFile(join(outdir, "output.js"));

      const modules: ModuleEntry[] = [];
      const json = stats!.toJson({ modules: true, assets: false });
      if (json.modules) {
        for (const mod of json.modules) {
          if (mod.name && mod.size != null) {
            modules.push({ path: mod.name, size: mod.size });
          }
        }
      }

      compiler.close(() => {});
      res({ bundler: "rspack", rawSize, gzipSize, durationMs, modules });
    });
  });
}

// ─── analysis helpers ───────────────────────────────────────────────────────

function printPackageBreakdown(results: BenchmarkResult[]) {
  const successful = results.filter((r) => !r.error && r.modules.length > 0);
  if (successful.length === 0) return;

  console.log("\n" + "═".repeat(76));
  console.log("  MODULE ANALYSIS — size contribution by package");
  console.log("═".repeat(76));
  console.log(
    "\n  Note: rollup/rolldown sizes are pre-minification (renderedLength),",
  );
  console.log(
    "  esbuild uses bytesInOutput, webpack/rspack use estimated module size.\n",
  );

  const grouped = successful.map((r) => ({
    bundler: r.bundler,
    groups: groupByPackage(r.modules),
  }));

  const colW = 12;
  const labelW = 18;
  let header = "  " + "Package".padEnd(labelW);
  for (const g of grouped) header += g.bundler.padStart(colW);
  console.log(header);
  console.log("  " + "─".repeat(labelW + colW * grouped.length));

  for (const pkg of PACKAGE_GROUPS) {
    const anyNonZero = grouped.some((g) => g.groups[pkg] > 0);
    if (!anyNonZero) continue;
    let row = "  " + pkg.padEnd(labelW);
    for (const g of grouped) {
      row += formatBytes(g.groups[pkg]).padStart(colW);
    }
    console.log(row);
  }

  console.log("  " + "─".repeat(labelW + colW * grouped.length));
  let totalRow = "  " + "Total".padEnd(labelW);
  for (const g of grouped) {
    const total = Object.values(g.groups).reduce((a, b) => a + b, 0);
    totalRow += formatBytes(total).padStart(colW);
  }
  console.log(totalRow);
}

function printTopModules(results: BenchmarkResult[], count = 25) {
  const successful = results.filter((r) => !r.error && r.modules.length > 0);
  if (successful.length === 0) return;

  for (const result of successful) {
    console.log("\n" + "═".repeat(76));
    console.log(`  TOP ${count} MODULES — ${result.bundler}`);
    console.log("═".repeat(76) + "\n");

    const sorted = [...result.modules].sort((a, b) => b.size - a.size);
    const top = sorted.slice(0, count);

    const pathW = 58;
    console.log("  " + "Module".padEnd(pathW) + "Size".padStart(12));
    console.log("  " + "─".repeat(pathW + 12));

    for (const m of top) {
      const short = shortModulePath(m.path);
      const display =
        short.length > pathW - 2 ? "…" + short.slice(-(pathW - 3)) : short;
      console.log(
        "  " + display.padEnd(pathW) + formatBytes(m.size).padStart(12),
      );
    }

    const otherCount = sorted.length - count;
    if (otherCount > 0) {
      const otherSize = sorted.slice(count).reduce((a, b) => a + b.size, 0);
      console.log(
        "  " +
          `... ${otherCount} more modules`.padEnd(pathW) +
          formatBytes(otherSize).padStart(12),
      );
    }

    const totalSize = sorted.reduce((a, b) => a + b.size, 0);
    console.log("  " + "─".repeat(pathW + 12));
    console.log(
      "  " +
        `Total (${sorted.length} modules)`.padEnd(pathW) +
        formatBytes(totalSize).padStart(12),
    );
  }
}

// ─── import graph analysis (esbuild metafile) ───────────────────────────────

function printImportGraphAnalysis() {
  const metaPath = join(OUT_DIR, "esbuild", "metafile.json");
  let meta: any;
  try {
    meta = JSON.parse(readFileSync(metaPath, "utf-8"));
  } catch {
    return;
  }

  const outKey = Object.keys(meta.outputs).find((k: string) =>
    k.endsWith("output.js"),
  );
  if (!outKey) return;
  const out = meta.outputs[outKey];

  console.log("\n" + "═".repeat(76));
  console.log("  IMPORT GRAPH ANALYSIS (esbuild metafile)");
  console.log("═".repeat(76));

  // 1. Find the largest modules and trace the import chain from entry
  const largeInputs = Object.entries(
    out.inputs as Record<string, { bytesInOutput: number }>,
  )
    .filter(([, v]) => v.bytesInOutput > 10_000)
    .sort((a, b) => b[1].bytesInOutput - a[1].bytesInOutput)
    .slice(0, 5);

  console.log("\n  Import chains to the 5 largest modules:\n");
  const entryKey = Object.keys(meta.inputs).find((k: string) =>
    k.includes("JobFunction"),
  );
  if (!entryKey) return;

  for (const [targetPath, info] of largeInputs) {
    const short = shortModulePath(targetPath);
    const display = short.length > 55 ? "…" + short.slice(-54) : short;
    console.log(`  ${display} (${formatBytes(info.bytesInOutput)})`);

    const chain = findImportChain(meta.inputs, entryKey, targetPath);
    if (chain && chain.length > 2) {
      for (let i = 0; i < chain.length; i++) {
        const step = shortModulePath(chain[i]!);
        const prefix = i === chain.length - 1 ? "└─" : "├─";
        console.log(`    ${"│ ".repeat(i)}${prefix} ${step}`);
      }
    }
    console.log("");
  }

  // 2. Show alchemy-effect service breakdown (what's included vs what's used)
  console.log("  alchemy-effect: included AWS services vs actually used\n");
  const serviceBytes: Record<string, number> = {};
  for (const [path, info] of Object.entries(
    out.inputs as Record<string, { bytesInOutput: number }>,
  )) {
    if (!path.includes("alchemy-effect/")) continue;
    if (info.bytesInOutput === 0) continue;
    const match = path.match(/alchemy-effect\/src\/AWS\/(\w+)\//);
    const svc = match ? match[1]! : "core";
    serviceBytes[svc] = (serviceBytes[svc] || 0) + info.bytesInOutput;
  }
  const usedServices = new Set(["Lambda", "S3", "SQS", "core"]);
  for (const [svc, bytes] of Object.entries(serviceBytes).sort(
    (a, b) => b[1] - a[1],
  )) {
    const used = usedServices.has(svc);
    const tag = used ? "  USED" : "  WASTED";
    console.log(
      `    ${formatBytes(bytes).padStart(10)}  ${svc.padEnd(16)}${tag}`,
    );
  }

  // 3. Wasted bytes in Cloudflare modules (should be 0 for AWS-only bundle)
  let cfBytes = 0;
  for (const [k, v] of Object.entries(
    out.inputs as Record<string, { bytesInOutput: number }>,
  )) {
    if (k.includes("Cloudflare")) cfBytes += v.bytesInOutput;
  }
  console.log(
    `\n    Cloudflare modules in output: ${cfBytes > 0 ? formatBytes(cfBytes) + " (WASTED)" : "0 B (properly tree-shaken)"}`,
  );
}

function findImportChain(
  inputs: Record<string, { imports: { path: string }[] }>,
  from: string,
  target: string,
): string[] | null {
  const visited = new Set<string>();
  function dfs(current: string, chain: string[]): string[] | null {
    if (visited.has(current)) return null;
    visited.add(current);
    chain.push(current);
    if (current === target) return [...chain];
    const info = inputs[current];
    if (!info) {
      chain.pop();
      return null;
    }
    for (const imp of info.imports) {
      if (imp.path) {
        const result = dfs(imp.path, chain);
        if (result) return result;
      }
    }
    chain.pop();
    return null;
  }
  return dfs(from, []);
}

// ─── cross-bundler comparison ───────────────────────────────────────────────

function printCrossBundlerComparison(results: BenchmarkResult[]) {
  const successful = results.filter((r) => !r.error && r.modules.length > 0);
  if (successful.length < 2) return;

  const ref =
    successful.find((r) => r.bundler === "rolldown") ?? successful[0]!;
  const esbuildResult = successful.find((r) => r.bundler === "esbuild");
  if (!esbuildResult || ref.bundler === "esbuild") return;

  console.log("\n" + "═".repeat(76));
  console.log(
    `  TREE-SHAKING GAP — esbuild vs ${ref.bundler} (alchemy-effect only)`,
  );
  console.log("═".repeat(76) + "\n");

  const refPaths = new Set(
    ref.modules.filter((m) => m.size > 0).map((m) => shortModulePath(m.path)),
  );
  const esbuildOnly = esbuildResult.modules
    .filter((m) => {
      if (m.size === 0) return false;
      if (!m.path.includes("alchemy-effect/")) return false;
      return !refPaths.has(shortModulePath(m.path));
    })
    .sort((a, b) => b.size - a.size);

  if (esbuildOnly.length === 0) {
    console.log("  No alchemy-effect modules unique to esbuild.");
    return;
  }

  const totalWasted = esbuildOnly.reduce((a, b) => a + b.size, 0);
  console.log(
    `  ${esbuildOnly.length} modules (${formatBytes(totalWasted)}) included by esbuild but tree-shaken by ${ref.bundler}:`,
  );
  console.log(
    "  These are pulled in via barrel re-exports that esbuild cannot trace.\n",
  );

  const pathW = 58;
  for (const m of esbuildOnly.slice(0, 15)) {
    const short = shortModulePath(m.path);
    const display =
      short.length > pathW - 2 ? "…" + short.slice(-(pathW - 3)) : short;
    console.log(
      "  " + display.padEnd(pathW) + formatBytes(m.size).padStart(12),
    );
  }
  if (esbuildOnly.length > 15) {
    console.log(`  ... and ${esbuildOnly.length - 15} more`);
  }
}

// ─── bun ─────────────────────────────────────────────────────────────────────

async function bundleBun(): Promise<BenchmarkResult> {
  const outdir = join(OUT_DIR, "bun");
  mkdirSync(outdir, { recursive: true });

  const externals = new Set<string>();

  const start = performance.now();
  const result = await Bun.build({
    entrypoints: [ENTRY],
    outdir,
    target: "bun",
    format: "esm",
    minify: true,
    metafile: true,
    conditions: ["bun"],
    drop: ["debugger"],
    plugins: [
      {
        name: "external-filter",
        setup(build) {
          build.onResolve({ filter: /^[^./]/ }, (args) => {
            if (isExternal(args.path)) {
              externals.add(args.path);
              return { path: args.path, external: true };
            }
            return undefined;
          });
        },
      },
    ],
  });
  const durationMs = performance.now() - start;

  if (!result.success) {
    const msg = result.logs.map((l) => l.message).join("\n");
    return {
      bundler: "bun",
      rawSize: 0,
      gzipSize: 0,
      durationMs,
      modules: [],
      error: msg,
    };
  }

  const { rawSize, gzipSize } = measureDir(outdir);

  const modules: ModuleEntry[] = [];
  if (result.metafile) {
    for (const [outPath, outInfo] of Object.entries(result.metafile.outputs)) {
      if (!outPath.endsWith(".js")) continue;
      for (const [modPath, modInfo] of Object.entries(outInfo.inputs)) {
        modules.push({ path: modPath, size: modInfo.bytesInOutput });
      }
    }
  }

  return { bundler: "bun", rawSize, gzipSize, durationMs, modules };
}

// ─── main ───────────────────────────────────────────────────────────────────

const bundlers = [
  { name: "bun", fn: bundleBun },
  { name: "esbuild", fn: bundleEsbuild },
  { name: "rollup", fn: bundleRollup },
  { name: "rolldown", fn: bundleRolldown },
  { name: "rolldown+terser", fn: bundleRolldownTerser },
  { name: "webpack", fn: bundleWebpack },
  { name: "rspack", fn: bundleRspack },
] as const;

async function main() {
  console.log(
    "Bundle Benchmark — tree-shaking comparison for effect + alchemy-effect\n",
  );
  console.log(`  Entry:  ${ENTRY}`);
  console.log(`  Output: ${OUT_DIR}\n`);

  rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });

  const results: BenchmarkResult[] = [];

  for (const { name, fn } of bundlers) {
    process.stdout.write(`  ${name.padEnd(12)} ... `);
    try {
      const result = await fn();
      if (result.error) {
        console.log(`ERROR (${result.durationMs.toFixed(0)}ms)`);
        console.log(`             ${result.error.split("\n")[0]}`);
      } else {
        console.log(
          `${formatBytes(result.rawSize).padStart(10)} raw  ${formatBytes(result.gzipSize).padStart(10)} gzip  ${result.durationMs.toFixed(0)}ms`,
        );
      }
      results.push(result);
    } catch (e: any) {
      console.log("FAILED");
      console.log(`             ${e.message?.split("\n")[0] ?? e}`);
      results.push({
        bundler: name,
        rawSize: 0,
        gzipSize: 0,
        durationMs: 0,
        modules: [],
        error: e.message ?? String(e),
      });
    }
  }

  // ── Module analysis (printed first, before final summary) ────────────────

  printPackageBreakdown(results);
  printImportGraphAnalysis();
  printCrossBundlerComparison(results);
  printTopModules(results, 15);

  // ── Final summary ─────────────────────────────────────────────────────────

  const successful = results.filter((r) => !r.error);
  const failed = results.filter((r) => r.error);

  console.log("\n" + "═".repeat(76));
  console.log("  RESULTS — sorted by raw size (smallest first)");
  console.log("═".repeat(76) + "\n");

  if (successful.length > 0) {
    successful.sort((a, b) => a.rawSize - b.rawSize);
    const best = successful[0]!;

    console.log(
      "  " +
        "Bundler".padEnd(14) +
        "Raw Size".padStart(12) +
        "Gzip Size".padStart(12) +
        "Duration".padStart(12) +
        "vs Best".padStart(12),
    );
    console.log("  " + "─".repeat(62));

    for (const r of successful) {
      const ratio = best.rawSize > 0 ? (r.rawSize / best.rawSize - 1) * 100 : 0;
      const ratioStr = ratio === 0 ? "baseline" : `+${ratio.toFixed(1)}%`;
      console.log(
        "  " +
          r.bundler.padEnd(14) +
          formatBytes(r.rawSize).padStart(12) +
          formatBytes(r.gzipSize).padStart(12) +
          `${r.durationMs.toFixed(0)}ms`.padStart(12) +
          ratioStr.padStart(12),
      );
    }
  }

  if (failed.length > 0) {
    console.log("\n  Failed:");
    for (const r of failed) {
      console.log(`    ${r.bundler}: ${r.error?.split("\n")[0]}`);
    }
  }

  console.log("");
}

main().catch(console.error);
