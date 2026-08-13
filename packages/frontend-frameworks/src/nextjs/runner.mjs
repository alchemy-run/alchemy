// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
// Programmatic @opennextjs/cloudflare build runner — NO wrangler binary, NO
// wrangler.json. Executed as a disposable child process (see Build.ts): the
// upstream pipeline mutates cwd-coupled module state, spawns `next build`, and
// can process.exit(1), so it must never run inside the harness process.
//
// Instead of importing `dist/cli/commands/utils/utils.js` (which imports
// `unstable_readConfig` from "wrangler" at module scope), the two thin
// `compileConfig` / `getNormalizedOptions` wrappers are vendored here (~15
// lines) over `@opennextjs/aws` exports so that NOTHING on this path ever
// imports wrangler code. (`ensureNextjsVersionSupported` still imports
// `wrangler/package.json` — a JSON version read satisfied by the inert
// `wrangler-stub` package this integration ships.)
//
// Usage: node runner.mjs '<json>' where json is Build.ts's RunnerConfig:
//   { appDir, configPath, compatibilityDate, skipNextBuild, minify, debug }
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const runnerConfig = JSON.parse(process.argv[2] ?? "{}");
const appDir = path.resolve(runnerConfig.appDir ?? process.cwd());
process.chdir(appDir); // upstream reads process.cwd() at module scope

// Resolve @opennextjs/cloudflare from the *app's* dependency tree (the app
// provides it — its open-next.config.ts imports it, so it must be there).
const require = createRequire(path.join(appDir, "package.json"));
// The exports map doesn't expose "./package.json"; resolve the "." entry
// (dist/api/index.js) and walk up to the package root.
const cfApiIndex = require.resolve("@opennextjs/cloudflare");
const cfRoot = path.resolve(path.dirname(cfApiIndex), "..", "..");
const cfRequire = createRequire(path.join(cfRoot, "package.json"));

/** Import a file from the @opennextjs/cloudflare dist (bypasses the exports map). */
const importCf = (p) => import(pathToFileURL(path.join(cfRoot, p)).href);
/** Import a subpath of @opennextjs/aws resolved from the cloudflare package. */
const importAws = (p) =>
  import(pathToFileURL(cfRequire.resolve(`@opennextjs/aws/${p}`)).href);

const { compileOpenNextConfig } = await importAws("build/compileConfig.js");
const { normalizeOptions } = await importAws("build/helper.js");
const { default: logger } = await importAws("logger.js");
const { ensureCloudflareConfig } = await importCf(
  "dist/cli/build/utils/ensure-cf-config.js",
);
const { build } = await importCf("dist/cli/build/build.js");

// --- compileConfig equivalent (utils.ts) without the TTY/prompt coupling ---
const configPath = path.resolve(
  appDir,
  runnerConfig.configPath ?? "open-next.config.ts",
);
const { config, buildDir } = await compileOpenNextConfig(configPath, {
  compileEdge: true,
});
ensureCloudflareConfig(config);

// --- getNormalizedOptions equivalent (utils.ts) ---
const openNextDistDir = path.dirname(
  cfRequire.resolve("@opennextjs/aws/index.js"),
);
const options = normalizeOptions(config, openNextDistDir, buildDir);
logger.setLevel(runnerConfig.debug ? "debug" : "info");

// --- the minimal in-memory stand-in for wrangler's Unstable_Config ---
// The build pipeline reads exactly two fields (build.ts staleness warning;
// compile-init.ts __ASSETS_RUN_WORKER_FIRST__ define).
const wranglerConfig = {
  compatibility_date: runnerConfig.compatibilityDate,
  assets: { run_worker_first: true },
};

// The Next.js build runs programmatically through the project's own
// `next/dist/build` — no shelled build command. A `buildCommand` the
// project's open-next.config.ts sets explicitly is still honored through
// OpenNext's native (execSync) path. Every parameter after `dir` is
// defaulted on Next 15 and 16, so the bare call is version-tolerant; the
// standalone env set by setStandaloneBuildMode reaches it directly (same
// process).
const skipNextBuild = !!runnerConfig.skipNextBuild;
const programmaticNextBuild = !skipNextBuild && !config.buildCommand;
if (programmaticNextBuild) {
  const { setStandaloneBuildMode } = await importAws("build/buildNextApp.js");
  setStandaloneBuildMode(options);
  // next/dist/build is CJS — under dynamic import the module.exports lands
  // on `.default`, and the build function on ITS `.default`.
  const nextBuildModule = await import(
    pathToFileURL(require.resolve("next/dist/build")).href
  );
  const nextBuild =
    typeof nextBuildModule.default === "function"
      ? nextBuildModule.default
      : nextBuildModule.default.default;
  const nextAppDir = path.dirname(options.appPackageJsonPath);
  console.log(`Building Next.js app programmatically in ${nextAppDir}`);
  await nextBuild(nextAppDir);
}

const projectOptions = {
  sourceDir: appDir,
  skipNextBuild: skipNextBuild || programmaticNextBuild,
  skipWranglerConfigCheck: true,
  minify: !!runnerConfig.minify,
};

await build(options, config, projectOptions, wranglerConfig, false);
console.log(
  "[@alchemy.run/frontend-frameworks/nextjs] OpenNext build finished OK",
);
