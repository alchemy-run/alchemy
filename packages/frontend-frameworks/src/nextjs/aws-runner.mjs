// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
// Programmatic @opennextjs/aws build runner — NO `open-next` CLI binary and
// NO shelled `next build`. Executed as a disposable child process (see
// aws.ts): the upstream pipeline mutates cwd-coupled module state, spawns
// workers, and can `process.exit(1)`, so it must never run inside the
// harness process.
//
// This replicates `@opennextjs/aws`'s `build()` step sequence, replacing the
// one shell-out it contains — `buildNextjsApp` (an `execSync` of a build
// command) — with a programmatic invocation of the project's own
// `next/dist/build`. A `buildCommand` explicitly set in the project's
// open-next.config.ts is still honored through OpenNext's native path.
//
// Usage: node aws-runner.mjs '<json>' where json is aws.ts's RunnerConfig:
//   { appDir, configPath, skipNextBuild, debug,
//     dangerouslyUseUnsupportedNextVersion }
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const runnerConfig = JSON.parse(process.argv[2] ?? "{}");
const appDir = path.resolve(runnerConfig.appDir ?? process.cwd());
process.chdir(appDir); // upstream reads process.cwd() at module scope

// Resolve @opennextjs/aws from the *app's* dependency tree. The exports map
// has only a `"./*" -> "./dist/*"` pattern, so `index.js` is the stable
// resolvable subpath; the dist dir is derived from it.
const require_ = createRequire(path.join(appDir, "package.json"));
const awsDist = path.dirname(require_.resolve("@opennextjs/aws/index.js"));
const importAws = (p) => import(pathToFileURL(path.join(awsDist, p)).href);

const { compileOpenNextConfig } = await importAws("build/compileConfig.js");
const buildHelper = await importAws("build/helper.js");
const { setStandaloneBuildMode, buildNextjsApp } = await importAws(
  "build/buildNextApp.js",
);
const { compileCache } = await importAws("build/compileCache.js");
const { compileTagCacheProvider } = await importAws(
  "build/compileTagCacheProvider.js",
);
const { createCacheAssets, createStaticAssets } = await importAws(
  "build/createAssets.js",
);
const { createImageOptimizationBundle } = await importAws(
  "build/createImageOptimizationBundle.js",
);
const { createMiddleware } = await importAws("build/createMiddleware.js");
const { createRevalidationBundle } = await importAws(
  "build/createRevalidationBundle.js",
);
const { createServerBundle } = await importAws("build/createServerBundle.js");
const { createWarmerBundle } = await importAws("build/createWarmerBundle.js");
const { generateOutput } = await importAws("build/generateOutput.js");
const { patchOriginalNextConfig } = await importAws(
  "build/patch/patches/index.js",
);
const { default: logger } = await importAws("logger.js");

// --- build() equivalent (dist/build.js) with a programmatic next build ---
const configPath = path.resolve(
  appDir,
  runnerConfig.configPath ?? "open-next.config.ts",
);
const { config, buildDir } = await compileOpenNextConfig(configPath, {});

const options = buildHelper.normalizeOptions(config, awsDist, buildDir);
logger.setLevel(runnerConfig.debug ? "debug" : "info");

buildHelper.checkRunningInsideNextjsApp(options);
buildHelper.printNextjsVersion(options);
buildHelper.printOpenNextVersion(options);
buildHelper.checkNextVersionSupport(
  options.nextVersion,
  runnerConfig.dangerouslyUseUnsupportedNextVersion ?? false,
);

setStandaloneBuildMode(options); // NEXT_PRIVATE_STANDALONE + trace root env
buildHelper.initOutputDir(options);

if (runnerConfig.skipNextBuild) {
  logger.info("Skipping Next.js build (reusing existing .next)");
} else if (config.buildCommand) {
  // The project's own open-next.config.ts asked for a specific command —
  // honor it through OpenNext's native path.
  buildNextjsApp(options);
} else {
  // Programmatic `next build` through the project's own Next install. Every
  // parameter after `dir` is defaulted on Next 15 and 16, so the bare call
  // is version-tolerant. The standalone env set above reaches it directly —
  // same process, no env-propagation hazards.
  // next/dist/build is CJS — under dynamic import the module.exports lands
  // on `.default`, and the build function on ITS `.default`.
  const nextBuildModule = await import(
    pathToFileURL(require_.resolve("next/dist/build")).href
  );
  const nextBuild =
    typeof nextBuildModule.default === "function"
      ? nextBuildModule.default
      : nextBuildModule.default.default;
  const appPath = path.dirname(options.appPackageJsonPath);
  console.log(`Building Next.js app programmatically in ${appPath}`);
  await nextBuild(appPath);
}

await patchOriginalNextConfig(options);
compileCache(options);
await createMiddleware(options);
createStaticAssets(options);
if (config.dangerous?.disableIncrementalCache !== true) {
  const { useTagCache } = createCacheAssets(options);
  if (useTagCache) {
    await compileTagCacheProvider(options);
  }
}
await createServerBundle(options);
await createRevalidationBundle(options);
await createImageOptimizationBundle(options);
await createWarmerBundle(options);
await generateOutput(options);
logger.info("OpenNext build complete.");
console.log(
  "[@alchemy.run/frontend-frameworks/nextjs] OpenNext AWS build finished OK",
);
// Next's build workers can keep the event loop alive after completion —
// this is a disposable child, exit explicitly.
process.exit(0);
