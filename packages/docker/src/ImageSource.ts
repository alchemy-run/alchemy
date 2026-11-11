import { AlchemyContext } from "alchemy/AlchemyContext";
import * as Bundle from "alchemy/Bundle/Bundle";
import {
  normalizeInstallTargets,
  resolvePackageInstallIdentity,
  type PackageInstall,
} from "alchemy/Bundle/InstalledPackages";
import { findCwdForBundle, getStableContextDir, resolveMainPath } from "alchemy/Bundle/TempRoot";
import {
  contextRootOf,
  copyExtraFiles,
  hashExtraFiles,
  posixRelUnder,
  resolveExtraSource,
  type ExtraFile,
} from "alchemy/Util/extraFiles";
import { sha256 } from "alchemy/Util/sha256";
import { sha256Object } from "alchemy/Util/sha256";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import type * as rolldown from "rolldown";
import { type BuildCacheOptions, imageBuildCacheOptions } from "./BuildCache.ts";
import { hashDockerBuildInputs } from "./BuildHash.ts";
import { Docker, type RegistryCredentials } from "./Docker.ts";
import { isInlineDockerfile, type InlineDockerfile } from "./Dockerfile.ts";

/** Context subdirectory a bundled image's extra files are copied through. */
const EXTRA_DIR = "alchemy-extra-files";

/**
 * INTERNAL — registry-agnostic container image-source machinery shared by
 * the container platforms (`AWS.ECS.*`, `AWS.EKS.*` via ECR, and
 * `Kubernetes.*` workloads pushing to any registry).
 *
 * NOT exported from any barrel. Consumers import the module path directly.
 *
 * A platform's props separate the ENVIRONMENT (what the container is) from
 * the PROGRAM (`main` — "and run my bundled Effect program in it"):
 *
 * - environment (at most one): `image` (registry ref) | `context` +
 *   `dockerfile`-as-path (docker build) | inline `dockerfile` content
 *   (`Dockerfile.inline`) | the default bun base when `main` stands alone.
 * - `main` present → the bundle is injected into the environment (COPY +
 *   ENTRYPOINT) and pushed as a derived image. `main` absent → the
 *   environment runs verbatim: `image` is mirrored (docker pull → tag →
 *   push, content-addressed on the ref), a Dockerfile builds as-is.
 * - `main` absent and an {@link ImageAgent} requested → the environment
 *   still runs verbatim, and the agent is pushed beside it as an image of
 *   its own, for the platform to mount into the environment's container.
 *
 * Where images land is an {@link ImageRegistryTarget}: ECR supplies one that
 * auto-creates a private repository; a plain registry (a local `registry`
 * container, GHCR, Docker Hub, …) supplies one that pushes to
 * `<server>/<name>`.
 */

/**
 * Bundle an Effect program into a generated image. Alchemy bundles `main`
 * with rolldown and bakes it into a Dockerfile generated from the
 * environment (`image`, `dockerfile`, or the default bun base).
 */
export interface BundledImageSource {
  /**
   * Module entrypoint for the bundled program. This should typically be
   * `import.meta.url` from an inline Effect program.
   */
  main: string;
  /**
   * @internal Dockerfile lines contributed by mount bindings (see
   * `alchemy/Mount`), inserted after the environment preamble so a
   * program change doesn't reinstall them. Hosts fold these in from their
   * bindings; users don't set them.
   */
  install?: ReadonlyArray<string>;
  /**
   * Environment image: used as the generated Dockerfile's `FROM`. Any
   * registry ref works (private non-ECR registries require docker
   * credentials on the build machine); the image must be able to run the
   * bun runtime. Exclusive with {@link dockerfile} / {@link context}.
   * @default "oven/bun:1"
   */
  image?: string;
  /**
   * Environment Dockerfile: a string is a PATH (built in {@link context},
   * then the bundle is layered on top in a second stage); an
   * {@link InlineDockerfile} is inline content used as the environment
   * preamble (built with no context — its own `COPY`s are unsupported).
   * The resulting environment must be able to run the bun runtime.
   * Exclusive with {@link image}.
   */
  dockerfile?: string | InlineDockerfile;
  /**
   * Build context for a path {@link dockerfile} environment. Exclusive
   * with {@link image} and inline dockerfiles.
   */
  context?: string;
  /**
   * Named export to load from `main`.
   * @default "default"
   */
  handler?: string;
  /**
   * Bundler configuration for the entrypoint. Unused code is tree-shaken.
   * `effect`, alchemy, and `@distilled.cloud` are marked pure so unused
   * parts prune more aggressively. List extra packages with
   * `pure.packages`, or disable with `pure: false`. `cache` configures the
   * image build's BuildKit layer cache.
   */
  build?: Bundle.BundleConfig & BuildCacheOptions;
  /**
   * Files and directories copied into the image next to the bundle, under
   * `/app` (for example a website's client assets). Part of the image's
   * content hash.
   */
  extraFiles?: ReadonlyArray<ExtraFile>;
  /**
   * Packages `npm install`ed into an unbundled Node program's image instead
   * of bundled (native modules such as Next.js's `sharp`), at the versions
   * the project resolves. Only for an external `main` with `extraFiles`.
   */
  packages?: PackageInstall;
}

/**
 * Build arguments, BuildKit secrets and the layer cache for an image built
 * from the user's own Dockerfile (`context` / `dockerfile`).
 */
export interface DockerfileBuild extends BuildCacheOptions {
  /**
   * Docker build arguments (`--build-arg`), read by `ARG` instructions.
   * They are part of the image's content hash, so changing one rebuilds the
   * image. Never pass secrets here: build args are visible in the image
   * history. Use {@link secrets} instead.
   */
  args?: Record<string, string>;
  /**
   * BuildKit secrets, keyed by id. Mount one in a `RUN` step with
   * `--mount=type=secret,id=<id>` and read it from `/run/secrets/<id>`, or
   * add `env=<NAME>` to expose it as an environment variable for that step.
   *
   * A secret never enters the image, its build history, or `docker`'s argv.
   * Secrets are left out of the image's content hash, so rotating one does
   * not rebuild the image.
   */
  secrets?: Record<string, Redacted.Redacted<string>>;
}

/** The `build` prop of a source built from the user's own Dockerfile. */
export interface DockerfileBuildOptions {
  /** Build arguments, BuildKit secrets and the layer cache for the Dockerfile build. */
  build?: DockerfileBuild;
}

/**
 * Build the image from the user's own Dockerfile and build context — no
 * Effect program is bundled.
 */
export interface DockerfileImageSource extends DockerfileBuildOptions {
  /**
   * Docker build context directory. Optional when {@link dockerfile} is
   * inline content (which builds with an empty context).
   */
  context?: string;
  /**
   * Path to the Dockerfile relative to the cwd (NOT the context), or
   * {@link InlineDockerfile} content. The Dockerfile must define its own
   * `CMD`/`ENTRYPOINT` (no program is injected).
   * @default `${context}/Dockerfile`
   */
  dockerfile?: string | InlineDockerfile;
}

/**
 * Run a pre-built registry image. Registry-backed platforms may mirror it
 * into their own registry (ECR: docker pull → tag → push).
 */
export interface RegistryImageSource {
  /**
   * A pre-built image reference, e.g.
   * `public.ecr.aws/docker/library/busybox:stable`.
   */
  image: string;
}

/**
 * The image-source union. Discriminated by presence: exactly one of
 * `main`, `context`, or `image`.
 */
export type ImageSourceProps = BundledImageSource | DockerfileImageSource | RegistryImageSource;

/** Loose bag shape used to sniff which source variant a props object is. */
export interface ImageSourceLike {
  main?: string;
  handler?: string;
  /** Bundler config for `main`; Docker build args and secrets for `context`. */
  build?: Bundle.BundleConfig & DockerfileBuild;
  context?: string;
  dockerfile?: string | InlineDockerfile;
  image?: string;
  /** @internal Mount-binding install lines (see {@link BundledImageSource.install}). */
  install?: ReadonlyArray<string>;
  /** Files copied next to a bundled `main` (see {@link BundledImageSource.extraFiles}). */
  extraFiles?: ReadonlyArray<ExtraFile>;
  /** Packages installed into an unbundled Node program's image (see {@link BundledImageSource.packages}). */
  packages?: PackageInstall;
}

/**
 * An unbundled Node program: an external `main` (already a complete
 * server) shipped with its `extraFiles` tree as built, so relative imports
 * between its chunks keep working.
 */
export const isNodeProgram = (source: ImageSourceLike, isExternal: boolean | undefined) =>
  isExternal === true && source.main !== undefined && source.extraFiles !== undefined;

const NODE_PROGRAM_BASE_IMAGE = "node:22-slim";

const nodeProgramDockerfile = (options: {
  image: string | undefined;
  entry: string;
  install: boolean;
  port: number | undefined;
}) => {
  const lines = [
    `FROM ${options.image ?? NODE_PROGRAM_BASE_IMAGE}`,
    `WORKDIR /app`,
    `ENV NODE_ENV=production`,
  ];
  if (options.install) {
    lines.push(
      `COPY package.json /app/package.json`,
      `RUN npm install --omit=dev --no-fund --no-audit && npm cache clean --force`,
    );
  }
  lines.push(`COPY . /app`, `ENV HOST=0.0.0.0`);
  if (options.port !== undefined) {
    lines.push(`ENV PORT=${String(options.port)}`, `EXPOSE ${String(options.port)}`);
  }
  lines.push(`ENTRYPOINT ["node", ${JSON.stringify(`/app/${options.entry}`)}]`);
  return `${lines.join("\n")}\n`;
};

export type ImageSourceKind = "main" | "context" | "image";

/**
 * Which image source a props bag declares. `main` always wins (the other
 * fields then describe its ENVIRONMENT); without `main`, `image` is the
 * mirrored-verbatim source and any `context`/`dockerfile` (path or inline)
 * is an external docker build.
 */
export const imageSourceKind = (source: ImageSourceLike): ImageSourceKind | undefined =>
  source.main !== undefined
    ? "main"
    : source.image !== undefined
      ? "image"
      : source.context !== undefined || source.dockerfile !== undefined
        ? "context"
        : undefined;

/**
 * `build.args` or `build.secrets` set on an image that is not built from the
 * user's own Dockerfile (a `main` program or a pre-built `image`), or
 * `build.cache` set on a pre-built `image`, which is never built.
 */
export class DockerfileBuildConflict extends Data.TaggedError("DockerfileBuildConflict")<{
  readonly id: string;
  readonly source: "main" | "image";
  readonly option?: "cache";
}> {
  override get message() {
    return this.option === "cache"
      ? `'${this.id}': 'build.cache' applies to an image Alchemy builds ('main' / 'context' / 'dockerfile'), not to a pre-built 'image'`
      : `'${this.id}': 'build.args' and 'build.secrets' apply to an image built from your own Dockerfile ('context' / 'dockerfile'), not to '${this.source}'`;
  }
}

/**
 * Dies with {@link DockerfileBuildConflict} when `build.args` or
 * `build.secrets` are set alongside `main` or `image`, or `build.cache`
 * alongside `image`.
 */
export const validateDockerfileBuild = (
  id: string,
  source: { main?: string; image?: string; build?: DockerfileBuild },
): Effect.Effect<void> =>
  (source.main !== undefined || source.image !== undefined) &&
  (source.build?.args !== undefined || source.build?.secrets !== undefined)
    ? Effect.die(
        new DockerfileBuildConflict({
          id,
          source: source.main !== undefined ? "main" : "image",
        }),
      )
    : source.main === undefined && source.image !== undefined && source.build?.cache
      ? Effect.die(new DockerfileBuildConflict({ id, source: "image", option: "cache" }))
      : Effect.void;

/**
 * Validate environment-source exclusivity. Dies (plan-time defect) on
 * `image`+`dockerfile`, `image`+`context`, inline-`dockerfile`+`context`, or
 * build args/secrets without a Dockerfile build.
 */
export const validateImageSource = (id: string, source: ImageSourceLike): Effect.Effect<void> => {
  if (source.image !== undefined && source.dockerfile !== undefined) {
    return Effect.die(
      new Error(
        `'${id}': 'image' and 'dockerfile' are both set — declare exactly one environment source (an 'image' ref, or a Dockerfile)`,
      ),
    );
  }
  if (source.image !== undefined && source.context !== undefined) {
    return Effect.die(
      new Error(
        `'${id}': 'image' and 'context' are both set — declare exactly one environment source`,
      ),
    );
  }
  if (
    source.dockerfile !== undefined &&
    isInlineDockerfile(source.dockerfile) &&
    source.context !== undefined
  ) {
    return Effect.die(
      new Error(
        `'${id}': inline 'dockerfile' content builds with no context — use a path dockerfile with 'context', or drop 'context'`,
      ),
    );
  }
  return validateDockerfileBuild(id, source);
};

/**
 * Where a resolved image is pushed. Each field is an Effect so a target can
 * create resources lazily (ECR creates the repository on first use).
 */
export interface ImageRegistryTarget<R = never> {
  /** The repository URI images are tagged into (`<repositoryUri>:<hash>`). */
  readonly repositoryUri: Effect.Effect<string, any, R>;
  /**
   * Whether the content-addressed tag is already in the registry. `true`
   * skips the build and push entirely.
   */
  readonly hasTag: (tag: string) => Effect.Effect<boolean, any, R>;
  /**
   * Push credentials. `undefined` pushes with the build machine's own
   * Docker configuration (`docker login`, credential helpers).
   */
  readonly credentials: Effect.Effect<RegistryCredentials | undefined, any, R>;
}

export interface ResolveContainerImageOptions {
  /** Logical resource id — keys the stable build-context directory. */
  id: string;
  /**
   * The props bag carrying the image source fields (`main` / `context` /
   * `image` plus their modifiers).
   */
  source: ImageSourceLike;
  /**
   * Target image platform.
   * @default "linux/amd64"
   */
  platform?: string;
  /**
   * Port the generated Dockerfile should `ENV PORT=` + `EXPOSE`
   * (`main` source only).
   */
  port?: number;
  /**
   * True when the resource was declared without an inline Effect impl —
   * `main` is then bundled as-is without the virtual-entry bootstrap.
   */
  isExternal?: boolean;
  /**
   * The virtual-entry bootstrap wrapped around `main` for Effect-native
   * programs: receives the resolved entry import path and returns the
   * generated entry module source.
   */
  bootstrap: (importPath: string) => string;
  /**
   * Publish an agent beside an image that has no `main`. See
   * {@link ImageAgent}. Ignored for a `main` source, whose program serves the
   * agent itself.
   */
  agent?: ImageAgent;
  /** Plan-status session used to emit build/push progress notes. */
  session: { note: (message: string) => Effect.Effect<void> };
}

/**
 * A program the platform runs inside a container whose image has none of its
 * own (`image` or `context`), so it can drive the container: a sandbox agent
 * that runs commands and serves files inside it.
 *
 * The image itself is never changed. The agent is bundled and pushed as an
 * image of its own, to the same repository, under an `agent-` tag. Run as a
 * container, that image copies the agent and its Bun runtime into
 * {@link IMAGE_AGENT_DIR} and exits. A platform mounts a volume there, shares
 * it with the image's container, and starts that container with
 * {@link imageAgentEntryPoint}.
 */
export interface ImageAgent {
  /**
   * Module that exports `bootstrap(): Promise<void>`, which runs the agent.
   * A path or a `file:` URL.
   */
  main: string;
}

/**
 * Where an {@link ImageAgent}'s image copies the agent and its runtime, and
 * where the image's container finds them.
 */
export const IMAGE_AGENT_DIR = "/opt/alchemy/sandbox";

/**
 * The entry point that starts an {@link ImageAgent} from
 * {@link IMAGE_AGENT_DIR}. Bun starts through the loader that came with it,
 * so the image's own libc (glibc, another musl, or none) is never consulted
 * and the image needs nothing installed. The container's command arrives as
 * the agent's arguments.
 */
export const imageAgentEntryPoint: ReadonlyArray<string> = [
  `${IMAGE_AGENT_DIR}/ld-musl.so.1`,
  "--library-path",
  `${IMAGE_AGENT_DIR}/lib`,
  `${IMAGE_AGENT_DIR}/bun`,
  `${IMAGE_AGENT_DIR}/index.mjs`,
];

/**
 * The image the agent's runtime comes from. The musl build of Bun runs on any
 * Linux image once its loader and C++ runtime come with it.
 */
const AGENT_RUNTIME_IMAGE = "oven/bun:1-alpine";

/** Where the agent's bundle sits inside its own image. */
const AGENT_BUNDLE_DIR = "/agent";

/**
 * The Dockerfile of an {@link ImageAgent}'s image: the runtime's image plus
 * the agent's bundle. Its entry point copies the runtime, the loader, the
 * C++ runtime and the bundle into {@link IMAGE_AGENT_DIR}, where the platform
 * mounted a volume, and exits.
 */
const AGENT_DOCKERFILE = `${[
  `FROM ${AGENT_RUNTIME_IMAGE}`,
  `COPY index.mjs ${AGENT_BUNDLE_DIR}/index.mjs`,
  `COPY *.js ${AGENT_BUNDLE_DIR}/`,
  `ENTRYPOINT ${JSON.stringify([
    "/bin/sh",
    "-ec",
    [
      `mkdir -p ${IMAGE_AGENT_DIR}/lib`,
      `cp /usr/local/bin/bun ${IMAGE_AGENT_DIR}/bun`,
      `cp /lib/ld-musl-*.so.1 ${IMAGE_AGENT_DIR}/ld-musl.so.1`,
      `cp /usr/lib/libstdc++.so.6 /usr/lib/libgcc_s.so.1 ${IMAGE_AGENT_DIR}/lib/`,
      `cp ${AGENT_BUNDLE_DIR}/* ${IMAGE_AGENT_DIR}/`,
      // The image's container may run as any user.
      `chmod -R a+rX ${IMAGE_AGENT_DIR}`,
    ].join(" && "),
  ])}`,
].join("\n")}\n`;

/** The generated entry of an {@link ImageAgent}: import the module and run it. */
const agentEntry = (importPath: string) =>
  `import { bootstrap } from ${JSON.stringify(importPath)};\nawait bootstrap();\n`;

/**
 * Resolve the Dockerfile path for a `context` source: always relative to the
 * cwd (absolute paths pass through), defaulting to `${context}/Dockerfile`.
 */
const resolveContextPaths = Effect.fn(function* (source: {
  context: string | undefined;
  dockerfile?: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const context = path.resolve(source.context ?? ".");
  const dockerfile = source.dockerfile
    ? path.resolve(source.dockerfile)
    : path.join(context, "Dockerfile");
  if (!(yield* fs.exists(context))) {
    return yield* Effect.die(new Error(`Docker build context does not exist: ${context}`));
  }
  if (!(yield* fs.exists(dockerfile))) {
    return yield* Effect.die(new Error(`Dockerfile does not exist: ${dockerfile}`));
  }
  return { context, dockerfile };
});

/**
 * Content hash for the sources whose identity is computable WITHOUT running
 * a bundler:
 *
 * - `context` — hash of the build-context directory + Dockerfile content +
 *   platform.
 * - `image` — hash of the image reference + platform (re-mirror only when
 *   the ref changes).
 * - `main` — `undefined`: the hash comes from the bundle output, so it is
 *   only known inside `resolve`.
 *
 * Providers use this in `diff` to surface content drift (files changed under
 * an unchanged `context` path) as an update.
 */
export const computeStaticSourceHash = Effect.fn(function* (
  source: ImageSourceLike,
  platform?: string,
) {
  const kind = imageSourceKind(source);
  if (kind === "image") {
    return (yield* sha256Object({
      image: source.image!,
      platform: platform ?? "linux/amd64",
    })).slice(0, 16);
  }
  if (kind === "context") {
    if (source.dockerfile !== undefined && isInlineDockerfile(source.dockerfile)) {
      // Inline content builds with no context; an unresolved (Output)
      // content can't be hashed at plan time — defer to reconcile.
      if (typeof source.dockerfile.content !== "string") return undefined;
      return (yield* sha256Object({
        dockerfile: source.dockerfile.content,
        platform: platform ?? "linux/amd64",
        // Absent when unset, so existing hashes hold. Secrets are excluded.
        buildArgs: source.build?.args,
      })).slice(0, 16);
    }
    const { context, dockerfile } = yield* resolveContextPaths({
      context: source.context!,
      dockerfile: source.dockerfile,
    });
    // Hash what Docker receives: the context `.dockerignore` keeps (never a
    // lockfile above it), the Dockerfile, platform and build args.
    return (yield* hashDockerBuildInputs(
      {
        context,
        dockerfile,
        platform: platform ?? "linux/amd64",
        buildArgs: source.build?.args,
      },
      "effective",
    )).slice(0, 16);
  }
  return undefined;
});

/**
 * The exact rolldown input/output options `bundleMainProgram` hands to
 * `Bundle.build` — shared with {@link watchMain} so a dev watcher's
 * `Bundle.watch` observes the identical module graph.
 */
export const mainBundleOptions = (
  source: BundledImageSource,
  entry: string,
  cwd: string,
  plugins?: rolldown.RolldownPluginOption,
): {
  inputOptions: rolldown.InputOptions;
  outputOptions: rolldown.OutputOptions;
} => ({
  inputOptions: {
    ...source.build?.input,
    input: entry,
    cwd,
    platform: "node",
    // The container runs on `bun`; keep `bun`/`bun:*` external (the
    // runtime provides them) and resolve the `bun` export condition
    // so `@effect/platform-bun` picks its Bun implementations.
    external: ["bun", "bun:*", ...((source.build?.input?.external as string[] | undefined) ?? [])],
    resolve: {
      conditionNames: [...Bundle.BUN_CONDITION_NAMES],
      ...source.build?.input?.resolve,
    },
    plugins: [source.build?.input?.plugins, plugins],
  },
  outputOptions: {
    ...source.build?.output,
    format: "esm",
    sourcemap: source.build?.output?.sourcemap ?? false,
    minify: source.build?.output?.minify ?? false,
    entryFileNames: "index.mjs",
  },
});

/**
 * Bundle the Effect program behind a `main` source: every emitted file
 * (entry + shared chunks) and the bundle hash. Needs no Docker engine, so
 * builders that are not Docker (`BuildPlan`) share it.
 */
export const bundleMainProgram = Effect.fn(function* (options: {
  source: BundledImageSource;
  isExternal?: boolean;
  bootstrap: (importPath: string) => string;
}) {
  const { source } = options;
  const virtualEntryPlugin = yield* Bundle.virtualEntryPlugin;
  const realMain = yield* resolveMainPath(source.main);
  const cwd = yield* findCwdForBundle(realMain);

  const buildBundle = Effect.fn(function* (entry: string, plugins?: rolldown.RolldownPluginOption) {
    const opts = mainBundleOptions(source, entry, cwd, plugins);
    return yield* Bundle.build(opts.inputOptions, opts.outputOptions, source.build);
  });

  const bundleOutput = options.isExternal
    ? yield* buildBundle(realMain)
    : yield* buildBundle(realMain, virtualEntryPlugin(options.bootstrap));

  // Return every emitted file (entry + shared chunks). Dynamic imports in
  // the Bun HTTP server / AWS SDK split into chunks; dropping any of them
  // crashes the container with `Cannot find module './chunk-XXX.js'`.
  const files = bundleOutput.files.map((file) => ({
    path: file.path,
    content:
      typeof file.content === "string" ? new TextEncoder().encode(file.content) : file.content,
  }));

  return { files, hash: bundleOutput.hash };
});

/**
 * Init-time constructor for the image-source resolver. Resolves the services
 * that are only available at provider-layer construction (Docker, the
 * `.alchemy` directory, the rolldown virtual-entry plugin) and returns
 * `resolve` (build/mirror + push to an {@link ImageRegistryTarget}), `hash`,
 * and `watchMain`.
 */
export const makeContainerImageSource = Effect.gen(function* () {
  const docker = yield* Docker;
  const { dotAlchemy } = yield* AlchemyContext;
  const virtualEntryPlugin = yield* Bundle.virtualEntryPlugin;
  // Pinning `packages` reads the project's lockfile through the package
  // manager; capture the spawner once so `hash` and `resolve` don't need it.
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  /**
   * Lay out an unbundled Node program and compute its content-addressed
   * code hash: the entry, the extra-files tree, the pinned packages (and
   * the lockfile they resolve from), the Dockerfile, and the platform.
   */
  const computeNodeProgram = Effect.fn(function* (options: {
    source: BundledImageSource;
    port?: number;
    platform: string;
  }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { source } = options;
    const realMain = yield* resolveMainPath(source.main);
    const extras = source.extraFiles ?? [];
    const root = contextRootOf(realMain, extras, path, (file) => resolveExtraSource(file, path));
    const entry = posixRelUnder(root, realMain, path) || path.basename(realMain);
    const requested = yield* normalizeInstallTargets(source.packages);
    const identity =
      Object.keys(requested).length > 0
        ? yield* resolvePackageInstallIdentity({
            cwd: yield* findCwdForBundle(realMain),
            requested,
          }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner))
        : undefined;
    const packageJson =
      identity !== undefined && Object.keys(identity.resolved).length > 0
        ? `${JSON.stringify({ private: true, type: "module", dependencies: identity.resolved }, null, 2)}\n`
        : undefined;
    const dockerfile = nodeProgramDockerfile({
      image: source.image,
      entry,
      install: packageJson !== undefined,
      port: options.port,
    });
    const mainBytes = yield* fs.readFile(realMain);
    const codeHash = (yield* sha256Object({
      main: yield* sha256(mainBytes),
      entry,
      dockerfile,
      packageJson,
      lockfile: identity?.lockfile,
      extraFiles: yield* hashExtraFiles(extras),
      platform: options.platform,
    })).slice(0, 16);
    return { realMain, mainBytes, entry, dockerfile, packageJson, codeHash };
  });

  /**
   * Bundle a `main` source and compute its content-addressed code hash.
   *
   * The hash covers the FULL image identity: the bundle output (which
   * includes the generated bootstrap entry, so bootstrap-template changes
   * invalidate it), the generated Dockerfile, and the target platform.
   * `resolve` and `hash` share this so the plan-time diff hash and the
   * pushed image tag always agree.
   */
  const computeMainCodeHash = Effect.fn(function* (options: {
    source: BundledImageSource;
    isExternal?: boolean;
    bootstrap: (importPath: string) => string;
    port?: number;
    platform: string;
  }) {
    const bundled = yield* bundleMainProgram({
      source: options.source,
      isExternal: options.isExternal,
      bootstrap: options.bootstrap,
    });
    // A path-`dockerfile` environment is built as a separate local stage in
    // `resolve`; hash its identity (context files + Dockerfile content)
    // explicitly since the generated Dockerfile only references the local
    // env tag. Inline environments flow through the generated Dockerfile
    // text itself; `image` environments through its FROM line.
    const df = options.source.dockerfile;
    const isPathEnv = df !== undefined && !isInlineDockerfile(df);
    let envIdentity: Record<string, string> = {};
    if (isPathEnv) {
      const { context, dockerfile } = yield* resolveContextPaths({
        context: options.source.context!,
        dockerfile: df,
      });
      envIdentity = {
        envContextHash: yield* hashDockerBuildInputs(
          { context, dockerfile, platform: options.platform },
          "effective",
        ),
      };
    }
    const dockerfile = generateDockerfile(
      options.source,
      options.port,
      isPathEnv ? "<env>" : undefined,
    );
    // Extra files join the identity only when there are any, so images
    // without them keep their tags.
    const extras =
      options.source.extraFiles !== undefined && options.source.extraFiles.length > 0
        ? { extraFiles: yield* hashExtraFiles(options.source.extraFiles) }
        : {};
    const codeHash = (yield* sha256Object({
      bundleHash: bundled.hash,
      dockerfile,
      platform: options.platform,
      ...envIdentity,
      ...extras,
    })).slice(0, 16);
    return { bundled, dockerfile, codeHash };
  });

  /**
   * Generated Dockerfile for a bundled `main` program. The environment
   * preamble is, in order of precedence: `envFrom` (a locally-built
   * environment tag from a path-`dockerfile` two-stage build), inline
   * `dockerfile` content (already resolved), the `image` ref, or the
   * default bun base (`oven/bun` is Docker-Hub only — there is no
   * `docker/library/bun` and no `public.ecr.aws/oven/bun`).
   */
  const generateDockerfile = (source: BundledImageSource, port?: number, envFrom?: string) => {
    const preamble =
      envFrom !== undefined
        ? `FROM ${envFrom}`
        : source.dockerfile !== undefined && isInlineDockerfile(source.dockerfile)
          ? (source.dockerfile.content as string).trimEnd()
          : `FROM ${source.image ?? "oven/bun:1"}`;
    const lines = [
      preamble,
      ...(source.install ?? []),
      `WORKDIR /app`,
      `COPY index.mjs /app/index.mjs`,
      // Copy any additional rolldown chunks (`chunk-XXX.js`,
      // `BunServices-YYY.js`, …). Non-trivial bundles always emit at
      // least one; minimal bundles emit none and the COPY no-ops.
      `COPY *.js /app/`,
      ...(source.extraFiles !== undefined && source.extraFiles.length > 0
        ? [`COPY ${EXTRA_DIR}/ /app/`]
        : []),
    ];
    if (port !== undefined) {
      lines.push(`ENV PORT=${String(port)}`, `EXPOSE ${String(port)}`);
    }
    lines.push(`ENTRYPOINT ["bun", "/app/index.mjs"]`);
    return `${lines.join("\n")}\n`;
  };

  /**
   * Bundle an {@link ImageAgent} and compute the content-addressed hash of
   * its image: the bundle, the Dockerfile and the platform. `resolve` and
   * `hash` share this, so the plan-time hash and the pushed tag agree.
   */
  const bundleAgent = Effect.fn(function* (agent: ImageAgent, platform: string) {
    const bundled = yield* bundleMainProgram({
      source: { main: agent.main },
      isExternal: false,
      bootstrap: agentEntry,
    });
    const hash = (yield* sha256Object({
      bundleHash: bundled.hash,
      dockerfile: AGENT_DOCKERFILE,
      platform,
    })).slice(0, 16);
    return { bundled, hash };
  });

  /** One hash for an image and the agent published beside it. */
  const hashWithAgent = Effect.fn(function* (environment: string, agent: string) {
    return (yield* sha256Object({ environment, agent })).slice(0, 16);
  });

  /**
   * Build (or mirror) and push an image to `target`, pushing with the
   * target's credentials or — when it has none — the build machine's own
   * Docker login.
   */
  const push = (
    imageUri: string,
    credentials: RegistryCredentials | undefined,
    platform?: string,
  ) =>
    (credentials === undefined
      ? docker.run([
          "image",
          "push",
          ...(platform !== undefined ? ["--platform", platform] : []),
          imageUri,
        ])
      : docker.image.push(imageUri, credentials, platform)
    ).pipe(
      // Pushes are idempotent; transient registry-transport failures
      // (Docker Desktop's embedded proxy timing out under load, registry
      // 503s, credential helper contention) resolve on a bounded re-attempt.
      Effect.retry({
        while: (): boolean => true,
        schedule: Schedule.exponential("2 seconds"),
        times: 3,
      }),
    );

  const buildAndPush = Effect.fnUntraced(function* <R>(
    target: ImageRegistryTarget<R>,
    options: {
      imageUri: string;
      context: string;
      dockerfile?: string;
      platform?: string;
      build?: DockerfileBuild;
    },
  ) {
    const credentials = yield* target.credentials;
    yield* docker.image.build({
      tag: options.imageUri,
      context: options.context,
      file: options.dockerfile,
      platform: options.platform,
      "build-arg": options.build?.args,
      secrets: options.build?.secrets,
      ...imageBuildCacheOptions(options.build, options.imageUri, credentials),
    });
    yield* push(options.imageUri, credentials, options.platform);
    return options.imageUri;
  });

  /**
   * Resolve the image of a props bag's own source: resolve the target repository,
   * compute the content-addressed tag, then build/mirror + push only when
   * that exact tag is not already in the registry (crash-safe convergence).
   */
  const resolveSource = Effect.fnUntraced(function* <R>(
    options: ResolveContainerImageOptions,
    target: ImageRegistryTarget<R>,
  ) {
    const { id, source, session } = options;
    const platform = options.platform ?? "linux/amd64";
    const kind = imageSourceKind(source);
    if (kind === undefined) {
      return yield* Effect.die(
        new Error(
          `'${id}' must declare exactly one image source: 'main' (bundled Effect program), 'context' (Dockerfile build), or 'image' (registry reference)`,
        ),
      );
    }

    yield* validateImageSource(id, source);

    const repositoryUri = yield* target.repositoryUri;

    if (kind === "main" && isNodeProgram(source, options.isExternal)) {
      yield* session.note(`Packaging ${id} program...`);
      const program = yield* computeNodeProgram({
        source: source as BundledImageSource,
        port: options.port,
        platform,
      });
      const imageUri = `${repositoryUri}:${program.codeHash}`;
      if (yield* target.hasTag(program.codeHash)) {
        return { imageUri, repositoryUri, codeHash: program.codeHash };
      }
      const fs = yield* FileSystem.FileSystem;
      const contextDir = yield* getStableContextDir(program.realMain, dotAlchemy, `${id}-image`);
      // The context is the program tree; start clean so no earlier build's
      // files ship with this one.
      yield* fs.remove(contextDir, { recursive: true }).pipe(Effect.ignore);
      yield* copyExtraFiles(contextDir, (source as BundledImageSource).extraFiles);
      yield* docker.materialize({
        context: contextDir,
        dockerfile: program.dockerfile,
        files: [
          { path: program.entry, content: program.mainBytes },
          ...(program.packageJson !== undefined
            ? [{ path: "package.json", content: program.packageJson }]
            : []),
        ],
      });
      yield* session.note(`Building container image ${imageUri}...`);
      yield* buildAndPush(target, {
        imageUri,
        context: contextDir,
        platform,
        build: { cache: (source as BundledImageSource).build?.cache },
      });
      yield* session.note(`Pushed ${imageUri}`);
      return { imageUri, repositoryUri, codeHash: program.codeHash };
    }

    if (kind === "main") {
      // Bundle → hash → (skip if pushed) → materialize generated Dockerfile
      // → build + push.
      const df = source.dockerfile;
      if (df !== undefined && isInlineDockerfile(df) && typeof df.content !== "string") {
        return yield* Effect.die(
          new Error(
            `'${id}': inline dockerfile content did not resolve to a string — Outputs in Dockerfile.inline must be resolvable at deploy time`,
          ),
        );
      }
      yield* session.note(`Bundling ${id} program...`);
      const { bundled, dockerfile, codeHash } = yield* computeMainCodeHash({
        source: source as BundledImageSource,
        isExternal: options.isExternal,
        bootstrap: options.bootstrap,
        port: options.port,
        platform,
      });
      const imageUri = `${repositoryUri}:${codeHash}`;

      if (yield* target.hasTag(codeHash)) {
        return { imageUri, repositoryUri, codeHash };
      }

      // A path-`dockerfile` environment builds first as a local stage in the
      // USER's context (so its COPYs resolve), then the generated Dockerfile
      // FROMs the local tag and layers the bundle on top.
      let envFrom: string | undefined;
      if (df !== undefined && !isInlineDockerfile(df)) {
        const env = yield* resolveContextPaths({
          context: source.context!,
          dockerfile: df,
        });
        envFrom = `alchemy-env-${id.toLowerCase()}:${codeHash}`;
        yield* session.note(`Building environment image for ${id}...`);
        // The user's Dockerfile holds the expensive steps, so the layer
        // cache applies to this stage rather than the bundle layered on top.
        yield* docker.image.build({
          context: env.context,
          file: env.dockerfile,
          tag: envFrom,
          platform,
          ...imageBuildCacheOptions(
            source.build,
            imageUri,
            source.build?.cache ? yield* target.credentials : undefined,
          ),
        });
      }
      const finalDockerfile =
        envFrom === undefined
          ? dockerfile
          : generateDockerfile(source as BundledImageSource, options.port, envFrom);

      const realMain = yield* resolveMainPath((source as BundledImageSource).main);
      const contextDir = yield* getStableContextDir(realMain, dotAlchemy, `${id}-image`);
      yield* docker.materialize({
        context: contextDir,
        dockerfile: finalDockerfile,
        // Entry chunk becomes `index.mjs`; all other chunks keep their
        // emitted `*.js` names so the entry's relative imports resolve.
        files: bundled.files.map((file, index) => ({
          path: index === 0 ? "index.mjs" : file.path,
          content: file.content,
        })),
      });
      const extraFiles = (source as BundledImageSource).extraFiles;
      if (extraFiles !== undefined && extraFiles.length > 0) {
        const path = yield* Path.Path;
        yield* copyExtraFiles(path.join(contextDir, EXTRA_DIR), extraFiles);
      }
      yield* session.note(`Building container image ${imageUri}...`);
      yield* buildAndPush(target, {
        imageUri,
        context: contextDir,
        platform,
        build: envFrom === undefined ? { cache: source.build?.cache } : undefined,
      });
      yield* session.note(`Pushed ${imageUri}`);
      return { imageUri, repositoryUri, codeHash };
    }

    if (kind === "image") {
      // Mirror: pull → tag → push. Content-addressed on the image ref, so
      // an already-mirrored ref is a no-op.
      const ref = (source as RegistryImageSource).image;
      const codeHash = (yield* computeStaticSourceHash(source, platform))!;
      const imageUri = `${repositoryUri}:${codeHash}`;

      if (yield* target.hasTag(codeHash)) {
        return { imageUri, repositoryUri, codeHash };
      }

      yield* session.note(`Pulling container image ${ref}...`);
      // A registry pull can wedge indefinitely under Docker Hub throttling /
      // credential-helper contention — bound it so a stuck pull fails the
      // deploy loudly instead of hanging the plan.
      yield* docker.image.pull(ref, platform).pipe(Effect.timeout("4 minutes"));
      yield* docker.image.tag(ref, imageUri);
      yield* session.note(`Pushing mirrored image ${imageUri}...`);
      const credentials = yield* target.credentials;
      // Pin the platform on push: with the containerd image store a bare
      // push of a multi-arch tag sends every locally-present variant — a
      // stale other-arch variant in the local cache would reach the
      // registry and the container would crash with `exec format error`.
      yield* push(imageUri, credentials, platform);
      yield* session.note(`Pushed ${imageUri}`);
      return { imageUri, repositoryUri, codeHash };
    }

    // kind === "context": docker build the user's Dockerfile — from a path
    // (in their context) or from inline content (empty stable context).
    const externalDf = (source as DockerfileImageSource).dockerfile;
    if (externalDf !== undefined && isInlineDockerfile(externalDf)) {
      if (typeof externalDf.content !== "string") {
        return yield* Effect.die(
          new Error(
            `'${id}': inline dockerfile content did not resolve to a string — Outputs in Dockerfile.inline must be resolvable at deploy time`,
          ),
        );
      }
      const codeHash = (yield* computeStaticSourceHash(source, platform))!;
      const imageUri = `${repositoryUri}:${codeHash}`;
      if (yield* target.hasTag(codeHash)) {
        return { imageUri, repositoryUri, codeHash };
      }
      const contextDir = yield* getStableContextDir(dotAlchemy, dotAlchemy, `${id}-image`);
      yield* docker.materialize({
        context: contextDir,
        dockerfile: externalDf.content,
        files: [],
      });
      yield* session.note(`Building container image ${imageUri}...`);
      yield* buildAndPush(target, {
        imageUri,
        context: contextDir,
        platform,
        build: source.build,
      });
      yield* session.note(`Pushed ${imageUri}`);
      return { imageUri, repositoryUri, codeHash };
    }

    const { context, dockerfile } = yield* resolveContextPaths({
      context: (source as DockerfileImageSource).context!,
      dockerfile: externalDf,
    });
    const codeHash = (yield* computeStaticSourceHash(source, platform))!;
    const imageUri = `${repositoryUri}:${codeHash}`;

    if (yield* target.hasTag(codeHash)) {
      return { imageUri, repositoryUri, codeHash };
    }

    yield* session.note(`Building container image ${imageUri}...`);
    yield* buildAndPush(target, {
      imageUri,
      context,
      dockerfile,
      platform,
      build: source.build,
    });
    yield* session.note(`Pushed ${imageUri}`);
    return { imageUri, repositoryUri, codeHash };
  });

  /**
   * Publish an {@link ImageAgent} as an image of its own, `agent-<hash>` in
   * the target repository, unless that tag is already there.
   */
  const resolveAgent = Effect.fnUntraced(function* <R>(
    options: {
      id: string;
      agent: ImageAgent;
      platform: string;
      repositoryUri: string;
      session: ResolveContainerImageOptions["session"];
    },
    target: ImageRegistryTarget<R>,
  ) {
    const { id, platform, session } = options;
    yield* session.note(`Bundling ${id} sandbox agent...`);
    const { bundled, hash } = yield* bundleAgent(options.agent, platform);
    const tag = `agent-${hash}`;
    const imageUri = `${options.repositoryUri}:${tag}`;
    if (yield* target.hasTag(tag)) {
      return { imageUri, hash };
    }
    const contextDir = yield* getStableContextDir(dotAlchemy, dotAlchemy, `${id}-agent`);
    yield* docker.materialize({
      context: contextDir,
      dockerfile: AGENT_DOCKERFILE,
      files: bundled.files.map((file, index) => ({
        path: index === 0 ? "index.mjs" : file.path,
        content: file.content,
      })),
    });
    yield* session.note(`Building sandbox agent image ${imageUri}...`);
    yield* buildAndPush(target, { imageUri, context: contextDir, platform });
    yield* session.note(`Pushed ${imageUri}`);
    return { imageUri, hash };
  });

  /**
   * Resolve the image for a props bag, and the {@link ImageAgent} published
   * beside it when one is asked for. The image is the user's own, unchanged;
   * `codeHash` then covers both images.
   */
  const resolve = Effect.fnUntraced(function* <R>(
    options: ResolveContainerImageOptions,
    target: ImageRegistryTarget<R>,
  ) {
    const image = yield* resolveSource(options, target);
    if (options.agent === undefined || imageSourceKind(options.source) === "main") {
      return { ...image, agent: undefined };
    }
    const published = yield* resolveAgent(
      {
        id: options.id,
        agent: options.agent,
        platform: options.platform ?? "linux/amd64",
        repositoryUri: image.repositoryUri,
        session: options.session,
      },
      target,
    );
    return {
      imageUri: image.imageUri,
      repositoryUri: image.repositoryUri,
      codeHash: yield* hashWithAgent(image.codeHash, published.hash),
      agent: { imageUri: published.imageUri },
    };
  });

  /**
   * Content hash for ANY source kind without building or pushing an image.
   *
   * For `main` sources this runs the bundler (bootstrap entry included) so
   * the hash reflects the exact image `resolve` would push — bootstrap
   * template changes and user-code edits both surface as drift. Providers
   * call this from `diff` and compare against `output.code.hash`; static
   * sources (`context` / `image`) delegate to
   * {@link computeStaticSourceHash}.
   */
  const hash = Effect.fn(function* (options: {
    source: ImageSourceLike;
    platform?: string;
    port?: number;
    isExternal?: boolean;
    bootstrap: (importPath: string) => string;
    agent?: ImageAgent;
  }) {
    const platform = options.platform ?? "linux/amd64";
    if (isNodeProgram(options.source, options.isExternal)) {
      const { codeHash } = yield* computeNodeProgram({
        source: options.source as BundledImageSource,
        port: options.port,
        platform,
      });
      return codeHash;
    }
    const kind = imageSourceKind(options.source);
    if (options.agent !== undefined && kind !== undefined && kind !== "main") {
      // The image and its agent are two images. One hash covers both, so a
      // new agent plans an update just as a new image does.
      const environment = yield* computeStaticSourceHash(options.source, platform);
      if (environment === undefined) return undefined;
      const agent = yield* bundleAgent(options.agent, platform);
      return yield* hashWithAgent(environment, agent.hash);
    }
    if (kind === "main") {
      // Unresolved inline environment content (an Output) can't be hashed
      // at plan time — return undefined so the diff defers to reconcile.
      const df = options.source.dockerfile;
      if (df !== undefined && isInlineDockerfile(df) && typeof df.content !== "string") {
        return undefined;
      }
      const { codeHash } = yield* computeMainCodeHash({
        source: options.source as BundledImageSource,
        isExternal: options.isExternal,
        bootstrap: options.bootstrap,
        port: options.port,
        platform,
      });
      return codeHash;
    }
    return yield* computeStaticSourceHash(options.source, platform);
  });

  /**
   * The rolldown watch plan for a `main` source — the exact input/output
   * options `resolve` bundles with, reusable verbatim with `Bundle.watch`
   * so a dev watcher observes the identical module graph and rebuild
   * triggers.
   */
  const watchMain = Effect.fn(function* (options: {
    source: BundledImageSource;
    isExternal?: boolean;
    bootstrap: (importPath: string) => string;
  }) {
    const realMain = yield* resolveMainPath(options.source.main);
    const cwd = yield* findCwdForBundle(realMain);
    const opts = mainBundleOptions(
      options.source,
      realMain,
      cwd,
      options.isExternal ? undefined : virtualEntryPlugin(options.bootstrap),
    );
    return { ...opts, extra: options.source.build };
  });

  return { resolve, hash, watchMain };
});

/** The resolver service returned by {@link makeContainerImageSource}. */
export interface ContainerImageSource extends Effect.Success<typeof makeContainerImageSource> {}
