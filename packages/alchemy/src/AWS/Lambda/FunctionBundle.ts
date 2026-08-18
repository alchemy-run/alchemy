/** @effect-diagnostics anyUnknownInErrorContext:off */

/**
 * The Lambda Function code-bundling machinery, extracted from the live
 * provider closure so it is reusable outside `FunctionProvider` — the floci
 * local provider's watch loop rebuilds the exact same artifact on file
 * change (see [FlociFunctionProvider](./FlociFunctionProvider.ts)).
 *
 * `makeFunctionBundler` resolves the platform services once and returns the
 * same `bundleCode(id, props)` the live provider always used, plus the
 * split-out pieces (`resolveBundlePlan` / `finishBundle` / `prebuiltCode`)
 * that let a watcher run `Bundle.watch` with the identical rolldown config
 * and post-process each incremental output into a deployable archive.
 */

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import type { PlatformError } from "effect/PlatformError";
import type * as rolldown from "rolldown";
import * as Bundle from "../../Bundle/Bundle.ts";
import {
  hashPackageInstallIdentity,
  installResolvedPackages,
  matchesPackageRoot,
  normalizeInstallTargets,
  resolvePackageInstallIdentity,
} from "../../Bundle/InstalledPackages.ts";
import * as TempRoot from "../../Bundle/TempRoot.ts";
import { Self } from "../../Self.ts";
import { sha256, sha256Object } from "../../Util/sha256.ts";
import { zipCode, zipFiles, type ZipFile } from "../../Util/zip.ts";
import type { FunctionArchitecture, FunctionProps } from "./Function.ts";

/**
 * Evaluates a user-supplied Rolldown `external` option (string, RegExp, array,
 * or predicate) for a single module id, preserving its original semantics.
 */
export const matchesConfiguredExternal = (
  external: rolldown.InputOptions["external"],
  moduleId: string,
  parentId: string | undefined,
  isResolved: boolean,
): boolean => {
  if (external === undefined) return false;
  if (typeof external === "function") {
    return external(moduleId, parentId, isResolved) === true;
  }
  const matchers = Array.isArray(external) ? external : [external];
  return matchers.some((matcher) =>
    typeof matcher === "string" ? matcher === moduleId : matcher.test(moduleId),
  );
};

/**
 * The resolved rolldown configuration for a `bundle: true` Function — the
 * exact input/output options `bundleCode` hands to `Bundle.build`, reusable
 * verbatim with `Bundle.watch` for incremental dev rebuilds, plus the
 * post-processing inputs `finishBundle` needs.
 */
export interface FunctionBundlePlan {
  readonly inputOptions: rolldown.InputOptions;
  readonly outputOptions: rolldown.OutputOptions;
  readonly extra: Bundle.BundleExtraOptions | undefined;
  readonly cwd: string;
  readonly requested: Record<string, string>;
  readonly sourcemap: boolean | "inline" | "hidden";
  readonly uploadSourceMap: boolean;
  readonly architecture: FunctionArchitecture;
}

export interface FunctionBundleResult {
  /** Identity hash driving change detection in `diff` / watch dedupe. */
  readonly identityHash: string;
  /** Deferred archive build (performs native-package installs). */
  readonly buildArchive: Effect.Effect<
    { archive: Uint8Array<ArrayBufferLike>; archiveHash: string },
    any,
    any
  >;
}

export const makeFunctionBundler = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const virtualEntryPlugin = yield* Bundle.virtualEntryPlugin;

  // Recursively list every file under `root` as sorted POSIX-relative
  // paths (prebuilt-directory packaging).
  const walkFiles = (
    root: string,
  ): Effect.Effect<string[], PlatformError, never> =>
    Effect.gen(function* () {
      const out: string[] = [];
      const go: (rel: string) => Effect.Effect<void, PlatformError> = Effect.fn(
        function* (rel: string) {
          const absolute = rel === "" ? root : `${root}/${rel}`;
          const entries = yield* fs.readDirectory(absolute);
          for (const entry of entries) {
            const childRel = rel === "" ? entry : `${rel}/${entry}`;
            const info = yield* fs.stat(`${root}/${childRel}`);
            if (info.type === "Directory") {
              yield* go(childRel);
            } else {
              out.push(childRel);
            }
          }
        },
      );
      yield* go("");
      return out.sort();
    });

  // `bundle: false` — ship `main`'s directory as-is. Framework outputs
  // like nitro's `.output/server` are complete deployment units (entry +
  // chunks + their own `node_modules`); re-bundling them can orphan
  // CJS `require`s of exports-mapped subpaths.
  const prebuiltCode: (
    realMain: string,
  ) => Effect.Effect<FunctionBundleResult, any, any> = Effect.fn(function* (
    realMain: string,
  ) {
    const lastSlash = realMain.lastIndexOf("/");
    const dir = realMain.slice(0, lastSlash);
    const files = yield* walkFiles(dir);
    const archiveFiles: ZipFile[] = [];
    const fileHashes: Record<string, string> = {};
    for (const rel of files) {
      const content = yield* fs.readFile(`${dir}/${rel}`);
      archiveFiles.push({ path: rel, content });
      fileHashes[rel] = yield* sha256(content);
    }
    const identityHash = yield* sha256Object(fileHashes);
    const buildArchive = Effect.gen(function* () {
      const archive = yield* zipFiles(archiveFiles);
      return { archive, archiveHash: identityHash };
    });
    return { identityHash, buildArchive };
  });

  const resolveBundlePlan: (
    props: FunctionProps,
  ) => Effect.Effect<FunctionBundlePlan, any, any> = Effect.fn(function* (
    props: FunctionProps,
  ) {
    const {
      output: buildOutput,
      install,
      pure: _pure,
      bundleAnalyzer: _bundleAnalyzer,
      ...inputOptions
    } = props.build ?? {};
    const sourcemap = buildOutput?.sourcemap ?? true;
    const uploadSourceMap = props.uploadSourceMap ?? true;

    const realMain = yield* TempRoot.resolveMainPath(props.main);
    const cwd = yield* TempRoot.findCwdForBundle(realMain);

    const rolldownSourcemap = sourcemap;
    const architecture = props.architecture ?? "x86_64";

    // Explicit install roots are excluded from the bundle and installed
    // into the deployment artifact. build.external stays a pure Rolldown
    // escape hatch and is not installed by Alchemy.
    const requested = yield* normalizeInstallTargets(install);
    const installRoots = new Set(Object.keys(requested));
    const configuredExternal = inputOptions.external;
    const externalOption = (
      moduleId: string,
      parentId: string | undefined,
      isResolved: boolean,
    ): boolean => {
      if (moduleId.startsWith("@aws-sdk/")) return true;
      for (const root of installRoots) {
        if (matchesPackageRoot(moduleId, root)) return true;
      }
      return matchesConfiguredExternal(
        configuredExternal,
        moduleId,
        parentId,
        isResolved,
      );
    };

    const entryPlugin = props.isExternal
      ? undefined
      : virtualEntryPlugin(
          (importPath) => `
import { layer as nodeServicesLayer } from "@effect/platform-node/NodeServices";
import { Stack } from "alchemy/Stack";
import { makeEntrypointLayer, reifyBoundConfigProvider } from "alchemy/Runtime";
import { registerLambdaExtension } from "alchemy/AWS/Lambda/RuntimeExtension";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Credentials from "@distilled.cloud/aws/Credentials";
import * as Effect from "effect/Effect";
import * as Endpoint from "@distilled.cloud/aws/Endpoint";
import * as Exit from "effect/Exit";
import { layer as fetchHttpClientLayer } from "effect/unstable/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Region from "@distilled.cloud/aws/Region";
import * as Context from "effect/Context";
import * as Scope from "effect/Scope";
import { MinimumLogLevel } from "effect/References";

import entrypoint from ${JSON.stringify(importPath)};

// Register the internal extension: it buys the Shutdown phase (SIGTERM +
// 500 ms) — without any registered extension the sandbox is killed with no
// signal at all, and init-level finalizers would never run.
await registerLambdaExtension();

// Instance scope: the sandbox-lifetime layer build lives under it, and it is
// closed on SIGTERM (Lambda's Shutdown phase) so init-level finalizers run
// before the sandbox dies. Each invocation still gets its own request scope
// from the handler dispatch.
const instanceScope = Scope.makeUnsafe();

const tag = Context.Service("${Self.key}")
const layer = makeEntrypointLayer(tag, entrypoint);

const platform = Layer.mergeAll(
  nodeServicesLayer,
  fetchHttpClientLayer,
  // TODO(sam): wire this up to telemetry more directly
  Logger.layer([Logger.consolePretty()]),
);

const stack = Layer.effect(
  Stack,
  Effect.all([
    Config.string("ALCHEMY_STACK_NAME"),
    Config.string("ALCHEMY_STAGE")
  ]).pipe(
    Effect.map(([name, stage]) => ({
      name,
      stage,
      bindings: {},
      resources: {}
    }))
  )
);

const entryLayer = layer.pipe(
  Layer.provideMerge(stack),
  Layer.provideMerge(Credentials.fromEnv()),
  Layer.provideMerge(Region.fromEnv()),
  // AWS_ENDPOINT_URL is the LocalStack-standard override injected by local
  // emulators (floci) into the Lambda container — without it, runtime
  // bindings in \`alchemy dev\` would call REAL AWS with dummy credentials.
  // Resolves undefined when unset, so live deploys are unaffected.
  Layer.provideMerge(Endpoint.fromEnv()),
  Layer.provideMerge(platform),
  Layer.provideMerge(
    Layer.succeed(
      ConfigProvider.ConfigProvider,
      // Auto-bound \`Config\` values arrive in the env as
      // \`{"_tag":"Redacted","value":...}\` markers; reify them so a \`Config\`
      // re-read inside a handler decodes the raw source value.
      reifyBoundConfigProvider(ConfigProvider.fromEnv(), process.env)
    )
  ),
  Layer.provideMerge(
    Layer.succeed(
      MinimumLogLevel,
      process.env.DEBUG ? "Debug" : "Info",
    )
  ),
);

// Build the layer stack against the instance scope (not a transient
// \`Effect.provide\`/\`Effect.scoped\` region) so services and init-level
// finalizers live for the sandbox and are released at Shutdown.
const handlerEffect = Layer.buildWithScope(entryLayer, instanceScope).pipe(
  Effect.flatMap((context) =>
    tag.pipe(
      Effect.flatMap(func => func.RuntimeContext.exports),
      Effect.flatMap(exports => exports.handler),
      Effect.provideContext(context),
    )
  ),
  Scope.provide(instanceScope),
);

const handler = await Effect.runPromise(handlerEffect);

// Lambda's Shutdown phase: close the instance scope so init-level
// finalizers run, then exit inside the 500 ms budget. SIGKILL follows if we
// overstay, so finalizers must be fast and best-effort.
process.on("SIGTERM", () => {
  console.log("[alchemy] SIGTERM — closing instance scope");
  Effect.runPromise(Scope.close(instanceScope, Exit.void))
    .catch((error) => console.error("[alchemy] shutdown finalizers failed", error))
    .finally(() => process.exit(0));
});

export default handler;
`,
        );

    return {
      inputOptions: {
        ...inputOptions,
        input: realMain,
        cwd,
        external: externalOption,
        platform: "node",
        // Workspace tests and generated service patches execute
        // distilled from `src` through its `bun` export condition.
        // Resolve the deployed Lambda bundle the same way so a live
        // binding test cannot silently exercise stale `lib` output.
        resolve: {
          ...inputOptions.resolve,
          conditionNames: [
            "bun",
            ...(
              inputOptions.resolve?.conditionNames ?? [
                "node",
                "import",
                "module",
                "default",
              ]
            ).filter((condition) => condition !== "bun"),
          ],
        },
        plugins: [inputOptions.plugins, entryPlugin],
      },
      outputOptions: {
        ...buildOutput,
        format: "esm",
        sourcemap: rolldownSourcemap,
        minify: buildOutput?.minify ?? false,
        entryFileNames: "index.js",
        codeSplitting: buildOutput?.codeSplitting ?? false,
      },
      extra: props.build,
      cwd,
      requested,
      sourcemap: rolldownSourcemap,
      uploadSourceMap,
      architecture,
    } satisfies FunctionBundlePlan;
  });

  const finishBundle: (
    plan: FunctionBundlePlan,
    bundleOutput: Bundle.BundleOutput,
  ) => Effect.Effect<FunctionBundleResult, any, any> = Effect.fn(function* (
    plan: FunctionBundlePlan,
    bundleOutput: Bundle.BundleOutput,
  ) {
    const mainFile = bundleOutput.files[0];
    const code =
      typeof mainFile.content === "string"
        ? new TextEncoder().encode(mainFile.content)
        : mainFile.content;

    const includeSourceMaps =
      plan.uploadSourceMap &&
      (plan.sourcemap === true || plan.sourcemap === "hidden");

    const extraFiles = bundleOutput.files
      .slice(1)
      .filter(
        (f: Bundle.BundleFile) => includeSourceMaps || !f.path.endsWith(".map"),
      )
      .map((f: Bundle.BundleFile) => ({
        path: f.path,
        content: f.content,
      }));

    // Resolve install versions without running npm so `diff` can compare a
    // stable identity hash. The archive build performs the install.
    const installIdentity = yield* resolvePackageInstallIdentity({
      cwd: plan.cwd,
      requested: plan.requested,
    });
    const resolved = installIdentity.resolved;
    const hasInstalledPackages = Object.keys(resolved).length > 0;

    // Identity hash drives change detection in `diff`. With native packages,
    // the installed bytes are not captured by the bundle hash, so fold the
    // resolved versions, package-manager lockfile, and architecture in
    // instead of installing.
    const identityHash = hasInstalledPackages
      ? yield* hashPackageInstallIdentity({
          bundleHash: bundleOutput.hash,
          identity: installIdentity,
          architecture: plan.architecture,
        })
      : bundleOutput.hash;

    const buildArchive = Effect.gen(function* () {
      const installedPackageFiles = hasInstalledPackages
        ? yield* installResolvedPackages({
            resolved,
            overrides: installIdentity.overrides,
            architecture: plan.architecture,
          })
        : [];
      const archiveFiles = [...extraFiles, ...installedPackageFiles];
      const archive = yield* zipCode(
        code,
        archiveFiles.length > 0 ? archiveFiles : undefined,
      );
      // The S3 asset key is content-addressed, so the archive hash must be a
      // true hash of the bytes when native packages are present.
      const archiveHash =
        installedPackageFiles.length > 0
          ? yield* sha256(archive)
          : bundleOutput.hash;
      return { archive, archiveHash };
    });

    return { identityHash, buildArchive };
  });

  const bundleCode: (
    id: string,
    props: FunctionProps,
  ) => Effect.Effect<FunctionBundleResult, any, any> = Effect.fn(function* (
    _id: string,
    props: FunctionProps,
  ) {
    if (props.bundle === false) {
      const realMain = yield* TempRoot.resolveMainPath(props.main);
      return yield* prebuiltCode(realMain);
    }
    const plan = yield* resolveBundlePlan(props);
    const bundleOutput = yield* Bundle.build(
      plan.inputOptions,
      plan.outputOptions,
      plan.extra,
    );
    return yield* finishBundle(plan, bundleOutput);
  });

  return { bundleCode, prebuiltCode, resolveBundlePlan, finishBundle };
});
