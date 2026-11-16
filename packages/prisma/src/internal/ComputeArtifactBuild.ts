import * as Bundle from "alchemy/Bundle/Bundle";
import { findCwdForBundle } from "alchemy/Bundle/TempRoot";
import { hashDirectory } from "alchemy/Command/Memo";
import { Stack } from "alchemy/Stack";
import { sha256Object } from "alchemy/Util/sha256";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import type { ComputeAutoBuild, ComputeProps, ComputeStaticBuild } from "../Compute.ts";
import { createComputeArchive, normalizeEntrypoint } from "../ComputeArchive.ts";
import { runBuildCommand, runComputeAutoBuild, runComputeStaticBuild } from "../ComputeBuild.ts";
import { ALWAYS_IGNORED_PATTERNS } from "./ArchiveIgnore.ts";
import { normalizeBundleFilePath } from "./BundlePaths.ts";
import { ComputeInvalidProps, ComputeOperationFailed } from "./UrlCheck.ts";

export const processEnv = (
  env: Record<string, string | Redacted.Redacted<string> | null | undefined> = {},
) =>
  Object.fromEntries(
    Object.entries(env).flatMap(([key, value]) =>
      value === undefined || value === null
        ? []
        : [[key, Redacted.isRedacted(value) ? Redacted.value(value) : value]],
    ),
  ) as Record<string, string>;

export const isAutoBuild = (build: ComputeProps["build"]): build is "auto" | ComputeAutoBuild =>
  build === "auto" ||
  (typeof build === "object" && build !== null && "type" in build && build.type === "auto");

export const isStaticBuild = (build: ComputeProps["build"]): build is ComputeStaticBuild =>
  typeof build === "object" && build !== null && "type" in build && build.type === "static";

export class ComputePackageJsonError extends Data.TaggedError("ComputePackageJsonError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const readPackageMain = Effect.fn(function* (directory: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const text = yield* fs.readFileString(path.join(directory, "package.json")).pipe(
    Effect.catchIf(
      (error) => error._tag === "PlatformError" && error.reason._tag === "NotFound",
      () => Effect.undefined,
    ),
  );
  if (!text) return undefined;
  return yield* Effect.try({
    try: () => {
      const parsed = JSON.parse(text) as { main?: unknown };
      return typeof parsed.main === "string" ? parsed.main : undefined;
    },
    catch: (cause) =>
      new ComputePackageJsonError({
        message: `Failed to parse package.json in ${directory}: ${cause instanceof Error ? cause.message : String(cause)}`,
        cause,
      }),
  });
});

const writeBundleDirectory = Effect.fn(function* (bundle: Bundle.BundleOutput) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (bundle.files.length === 0) {
    return yield* new ComputeOperationFailed({
      message: "Effect-native Compute bundler produced no output files.",
    });
  }
  const normalizedFiles = yield* Effect.forEach(bundle.files, (file) =>
    normalizeBundleFilePath(file.path).pipe(
      Effect.map((normalizedPath) => ({ file, normalizedPath })),
    ),
  );
  const seen = new Set<string>();
  for (const { normalizedPath } of normalizedFiles) {
    if (seen.has(normalizedPath)) {
      return yield* new ComputeOperationFailed({
        message: `Effect-native Compute bundler produced duplicate output path '${normalizedPath}'.`,
      });
    }
    seen.add(normalizedPath);
  }
  const directory = yield* fs.makeTempDirectory({
    prefix: "alchemy-prisma-compute-",
  });

  return yield* Effect.gen(function* () {
    for (const { file, normalizedPath } of normalizedFiles) {
      const target = path.join(directory, normalizedPath);
      yield* fs.makeDirectory(path.dirname(target), { recursive: true });
      if (typeof file.content === "string") {
        yield* fs.writeFileString(target, file.content);
      } else {
        yield* fs.writeFile(target, file.content);
      }
    }

    return {
      directory,
      entrypoint: normalizedFiles[0].normalizedPath,
      cleanup: fs.remove(directory, { recursive: true }).pipe(Effect.ignore),
    };
  }).pipe(Effect.onError(() => fs.remove(directory, { recursive: true }).pipe(Effect.ignore)));
});

const bundleEffectCompute = Effect.fn(function* (props: ComputeArtifactBuildProps) {
  if (!props.main) {
    return yield* new ComputeInvalidProps({
      message:
        "Effect-native Prisma Compute apps require `main`. Set `main: import.meta.filename`.",
    });
  }

  const fs = yield* FileSystem.FileSystem;
  const stack = yield* Effect.serviceOption(Stack).pipe(
    Effect.map(
      Option.getOrElse(() => ({
        name: "alchemy",
        stage: "dev",
        bindings: {},
        resources: {},
      })),
    ),
  );
  const virtualEntryPlugin = yield* Bundle.virtualEntryPlugin;
  const realMain = yield* fs.realPath(props.main);
  const cwd = yield* findCwdForBundle(realMain);
  const handler = props.handler ?? "default";
  const defaultPort = props.port ?? 8080;

  const importEntrypoint =
    handler === "default" ? "import entrypoint" : `import { ${handler} as entrypoint }`;

  const bundle = yield* Bundle.build(
    {
      ...props.bundle?.input,
      input: realMain,
      cwd,
      platform: "node",
      // Prisma Compute runs the bundle on bun.
      resolve: {
        conditionNames: [...Bundle.BUN_CONDITION_NAMES],
        ...props.bundle?.input?.resolve,
      },
      plugins: [
        props.bundle?.input?.plugins,
        virtualEntryPlugin(
          (importPath) => `
import { bootstrap } from "@alchemy.run/prisma/Bootstrap";
${importEntrypoint} from ${JSON.stringify(importPath)};

await bootstrap(entrypoint, ${JSON.stringify({
            port: defaultPort,
            stack: { name: stack.name, stage: stack.stage },
          })});
`,
        ),
      ],
      checks: {
        unresolvedImport: false,
        ineffectiveDynamicImport: false,
      },
    },
    {
      ...props.bundle?.output,
      format: "esm",
      sourcemap: props.bundle?.output?.sourcemap ?? "hidden",
      minify: props.bundle?.output?.minify ?? true,
      entryFileNames: "index.js",
    },
    props.bundle?.extra,
  );

  const artifact = yield* writeBundleDirectory(bundle);
  const file = yield* createComputeArchive({
    directory: artifact.directory,
    entrypoint: artifact.entrypoint,
    ignore: props.archiveIgnore,
    output: "file",
  }).pipe(Effect.ensuring(artifact.cleanup));

  return {
    file,
    bundleHash: bundle.hash,
  };
});

/** The build-related props of `Prisma.Compute`, shared with `Prisma.ComputeArtifact`. */
export type ComputeArtifactBuildProps = Pick<
  ComputeProps,
  "path" | "archiveIgnore" | "entrypoint" | "main" | "handler" | "bundle" | "build" | "port"
>;

/**
 * Build the Compute artifact for `props`: the bundle of an Effect-native
 * `main`, an auto, static or command build, or an archive of `path`. The
 * returned file is temporary; the caller owns its `cleanup`.
 */
export const buildComputeArtifactFile = Effect.fn(function* (
  props: ComputeArtifactBuildProps,
  options: { readonly effectNative: boolean },
) {
  const defaultPort = props.port ?? 8080;
  if (options.effectNative) {
    const artifact = yield* bundleEffectCompute(props);
    return { file: artifact.file, port: defaultPort, bundleHash: artifact.bundleHash };
  }
  const path = yield* Path.Path;
  const appPath = path.resolve(props.path ?? ".");
  let directory = appPath;
  let entrypoint = props.entrypoint;
  let port = defaultPort;

  if (isAutoBuild(props.build)) {
    const auto = props.build === "auto" ? undefined : props.build;
    const artifact = yield* runComputeAutoBuild({
      appPath,
      entrypoint,
      framework: auto?.framework,
      env: auto?.env,
      outputLimitBytes: auto?.outputLimitBytes,
      timeoutSeconds: auto?.timeoutSeconds,
    });
    const file = yield* createComputeArchive({
      directory: artifact.directory,
      entrypoint: artifact.entrypoint,
      ignore: props.archiveIgnore,
      ignorePrefix: artifact.archiveIgnorePrefix,
      requiredFiles: artifact.requiredFiles,
      output: "file",
    }).pipe(Effect.ensuring(artifact.cleanup));
    port = props.port ?? artifact.defaultPort ?? 8080;
    return { file, port, bundleHash: undefined };
  }

  if (isStaticBuild(props.build)) {
    const artifact = yield* runComputeStaticBuild({
      appPath,
      command: props.build.command,
      cwd: props.build.cwd,
      outdir: props.build.outdir,
      indexPage: props.build.indexPage,
      spa: props.build.spa,
      env: props.build.env,
      outputLimitBytes: props.build.outputLimitBytes,
      timeoutSeconds: props.build.timeoutSeconds,
    });
    const file = yield* createComputeArchive({
      directory: artifact.directory,
      entrypoint: artifact.entrypoint,
      ignore: props.archiveIgnore,
      ignorePrefix: artifact.archiveIgnorePrefix,
      requiredFiles: artifact.requiredFiles,
      output: "file",
    }).pipe(Effect.ensuring(artifact.cleanup));
    port = props.port ?? artifact.defaultPort ?? 8080;
    return { file, port, bundleHash: undefined };
  }

  if (props.build) {
    const cwd = props.build.cwd ? path.resolve(props.build.cwd) : appPath;
    yield* runBuildCommand({
      command: props.build.command,
      cwd,
      env: processEnv(props.build.env),
      outputLimitBytes: props.build.outputLimitBytes,
      timeoutSeconds: props.build.timeoutSeconds,
    });
    directory = path.resolve(cwd, props.build.outdir);
    entrypoint = props.build.entrypoint ?? entrypoint;
  }

  entrypoint ??= yield* readPackageMain(directory);
  if (!entrypoint) {
    return yield* new ComputeInvalidProps({
      message:
        "Prisma Compute app entrypoint is required. Set `entrypoint` or package.json `main`.",
    });
  }

  const normalizedEntrypoint = yield* normalizeEntrypoint(entrypoint);
  const file = yield* createComputeArchive({
    directory,
    entrypoint: normalizedEntrypoint,
    ignore: props.archiveIgnore,
    output: "file",
  });
  return { file, port, bundleHash: undefined };
});

const plainBuildEnv = (env: unknown) =>
  typeof env === "object" && env !== null
    ? processEnv(env as Record<string, string | Redacted.Redacted<string> | null | undefined>)
    : undefined;

/**
 * Hash what {@link buildComputeArtifactFile} reads, the way `Command.Build`
 * decides whether to rebuild: the files of the build directory that git does
 * not ignore plus the nearest lockfile, and the build props. Archiving `path`
 * without a build hashes every file the archive would contain. An Effect-native
 * `main` hashes the package it is bundled from and the stack baked into the
 * bootstrap.
 */
export const computeArtifactInputsHash = Effect.fn(function* (props: ComputeArtifactBuildProps) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const settings = {
    entrypoint: props.entrypoint,
    handler: props.handler,
    bundle: props.bundle,
    port: props.port,
    archiveIgnore: props.archiveIgnore,
  };
  if (props.main !== undefined) {
    const realMain = yield* fs.realPath(props.main);
    const cwd = yield* findCwdForBundle(realMain);
    const stack = yield* Effect.serviceOption(Stack).pipe(
      Effect.map(Option.map(({ name, stage }) => ({ name, stage }))),
      Effect.map(Option.getOrUndefined),
    );
    const files = yield* hashDirectory({ cwd });
    return yield* sha256Object({
      kind: "main",
      files,
      main: path.relative(cwd, realMain),
      stack,
      ...settings,
    });
  }
  const appPath = path.resolve(props.path ?? ".");
  if (props.build === undefined || props.build === false) {
    const files = yield* hashDirectory({
      cwd: appPath,
      memo: {
        include: ["**/*"],
        exclude: [...ALWAYS_IGNORED_PATTERNS, ...(props.archiveIgnore ?? [])],
        lockfile: false,
      },
    });
    return yield* sha256Object({ kind: "path", files, ...settings });
  }
  const build = props.build === "auto" ? { type: "auto" as const } : props.build;
  const cwd = "cwd" in build && build.cwd ? path.resolve(build.cwd) : appPath;
  const files = yield* hashDirectory({ cwd });
  return yield* sha256Object({
    kind: "build",
    files,
    build: { ...build, env: plainBuildEnv("env" in build ? build.env : undefined) },
    ...settings,
  });
});
