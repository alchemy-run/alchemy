import { createRequire } from "node:module";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import type * as rolldown from "rolldown";
import * as Bundle from "../Bundle/Bundle.ts";
import {
  matchesPackageRoot,
  normalizeInstallTargets,
  parsePackageRootFromSpecifier,
  resolvePackageInstallIdentity,
  type PackageInstall,
} from "../Bundle/InstalledPackages.ts";
import {
  findCwdForBundle,
  getStableContextDir,
  resolveMainPath,
} from "../Bundle/TempRoot.ts";
import type { Docker } from "../Docker/Docker.ts";
import type { ResourceBinding } from "../Resource.ts";
import { safeHttpEffect } from "../Http.ts";
import { Self } from "../Self.ts";
import {
  createContainerRuntimeContext,
  type HostRuntimeContext,
} from "../Server/Process.ts";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { sha256, sha256Object } from "../Util/sha256.ts";
import type { MountSpec, ServiceBinding } from "./MountVolume.ts";

export type RailwayHostRuntimeContext = HostRuntimeContext;

/**
 * Container host. RPC wrapping lives in `Service.ts` so canvas Functions
 * do not pay for `rpc-server.ts` in the 96KB start command.
 */
export const createRailwayHostRuntimeContext = createContainerRuntimeContext;

/**
 * Function runtime: register the fetch handler on `globalThis` instead of
 * booting an HTTP server. The canvas wrapper `Bun.serve`s first so a
 * failed Effect import cannot 502 before the process is bound.
 */
export const createRailwayFunctionRuntimeContext =
  (type: string) =>
  (id: string): HostRuntimeContext => {
    const base = createContainerRuntimeContext(type)(id);
    return {
      ...base,
      serve: ((handler, options) =>
        Effect.sync(() => {
          if (!globalThis.__ALCHEMY_RUNTIME__) return;
          const run = safeHttpEffect(
            (globalThis as any).__R?.(options?.shape, handler) ?? handler,
          );
          (
            globalThis as typeof globalThis & {
              __ALCHEMY_FUNCTION_FETCH__?: (
                request: Request,
              ) => Promise<Response>;
            }
          ).__ALCHEMY_FUNCTION_FETCH__ = async (request: Request) => {
            try {
              const response = await Effect.runPromise(
                run.pipe(
                  Effect.provideService(
                    HttpServerRequest.HttpServerRequest,
                    HttpServerRequest.fromWeb(request),
                  ),
                  Effect.scoped,
                ),
              );
              return HttpServerResponse.toWeb(response);
            } catch (error) {
              return new Response(String(error), { status: 500 });
            }
          };
        })) as HostRuntimeContext["serve"],
      exports: Effect.sync(() => ({
        program: Effect.void,
      })),
    } as HostRuntimeContext;
  };

export const DEFAULT_BASE_IMAGE = "oven/bun:1";
export const DEFAULT_PORT = 3000;
export const MACHINE_PLATFORM = "linux/amd64";

export interface RailwayBuildOptions extends Bundle.BundleConfig {
  /**
   * Native or Node-only packages to install into the image with
   * `bun install` instead of bundling them. `pg` is CommonJS: Rolldown's
   * interop turns `Client` into a namespace (`The superclass is not a
   * constructor`). Same `build.install` shape as Lambda / Fly.
   *
   * @example
   * ```typescript
   * build: { install: ["pg"] }
   * ```
   */
  readonly install?: PackageInstall;
}

export interface HostedProgramProps {
  main: string;
  handler?: string;
  port?: number;
  /**
   * Dockerfile `FROM` for the Effect-native image. Ignored for the
   * public-image path (`props.image` without `main`).
   *
   * @default "oven/bun:1"
   */
  image?: string;
  env?: Record<string, any>;
  isExternal?: boolean;
  build?: RailwayBuildOptions;
  /**
   * Registry prefix Railway can pull from after we push the bundled
   * image (`ghcr.io/org`, `docker.io/user`). Required when `main` is set.
   */
  registry?: string;
}

const matchesConfiguredExternal = (
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

export class RegistryRequired extends Data.TaggedError(
  "Railway.RegistryRequired",
)<{
  message: string;
}> {}

export class RegistryCredentialsMissing extends Data.TaggedError(
  "Railway.RegistryCredentialsMissing",
)<{
  registry: string;
}> {}

const makeBunBootstrap =
  (handler: string) =>
  (importPath: string): string =>
    `
import { BunServices } from "@effect/platform-bun";
import { BunHttpServer } from "alchemy/Http";
import { Stack } from "alchemy/Stack";
import { makeEntrypointLayer, reifyBoundConfigProvider } from "alchemy/Runtime";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";

globalThis.__ALCHEMY_RUNTIME__ = true;
const { ${handler}: entrypoint } = await import(${JSON.stringify(importPath)});

const tag = Context.Service(${JSON.stringify(Self.key)});
const layer = makeEntrypointLayer(tag, entrypoint);

const platform = Layer.mergeAll(
  BunServices.layer,
  FetchHttpClient.layer,
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

const program = tag.pipe(
  Effect.flatMap((service) => service.RuntimeContext.exports),
  Effect.flatMap((exports) => exports.program),
  Effect.provide(
    layer.pipe(
      Layer.provideMerge(stack),
      Layer.provideMerge(BunHttpServer({ hostname: "0.0.0.0" })),
      Layer.provideMerge(platform),
      Layer.provideMerge(
        Layer.succeed(
          ConfigProvider.ConfigProvider,
          reifyBoundConfigProvider(ConfigProvider.fromEnv(), process.env)
        )
      ),
    )
  ),
  Effect.scoped
);

console.log("Railway service bootstrap starting...");
await Effect.runPromise(program).catch((err) => {
  console.error("Railway service bootstrap failed:", err);
  process.exit(1);
});
`;

/**
 * Inner Function module: builds the class layer so `serve` registers
 * `globalThis.__ALCHEMY_FUNCTION_FETCH__`. The canvas wrapper listens
 * first, then import()s this file.
 */
const makeFunctionBootstrap =
  (handler: string) =>
  (importPath: string): string =>
    `
import { makeEntrypointLayer, reifyBoundConfigProvider } from "alchemy/Runtime";
import { Stack } from "alchemy/Stack";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";

globalThis.__ALCHEMY_RUNTIME__ = true;
const { ${handler}: entrypoint } = await import(${JSON.stringify(importPath)});
const tag = Context.Service(${JSON.stringify(Self.key)});
const layer = makeEntrypointLayer(tag, entrypoint);
const platform = Layer.mergeAll(
  FetchHttpClient.layer,
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
await Effect.runPromise(
  tag.pipe(
    Effect.provide(
      layer.pipe(
        Layer.provideMerge(stack),
        Layer.provideMerge(platform),
        Layer.provideMerge(
          Layer.succeed(
            ConfigProvider.ConfigProvider,
            reifyBoundConfigProvider(ConfigProvider.fromEnv(), process.env)
          )
        ),
      )
    )
  )
);
`;

/** Flatten a binding/env leaf into an env string. Unwraps Redacted. */
export const plainEnvValue = (value: unknown): string | undefined => {
  if (value === undefined || value === null) return undefined;
  if (Redacted.isRedacted(value)) return plainEnvValue(Redacted.value(value));
  if (typeof value === "string") {
    if (value.startsWith("{")) {
      try {
        const parsed: unknown = JSON.parse(value);
        if (
          typeof parsed === "object" &&
          parsed !== null &&
          (parsed as { _tag?: unknown })._tag === "Redacted" &&
          typeof (parsed as { value?: unknown }).value === "string"
        ) {
          const inner = (parsed as { value: string }).value;
          return inner.length > 0 ? inner : undefined;
        }
      } catch {
        // plain string that happens to start with `{`
      }
    }
    return value.length > 0 ? value : undefined;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return undefined;
};

export const toEnvRecord = (
  env: Record<string, any> | undefined,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(env ?? {}).flatMap(([key, value]) => {
      const raw = plainEnvValue(value);
      return raw === undefined ? [] : [[key, raw]];
    }),
  );

const coerceBindingId = (value: unknown): string | undefined => {
  const direct = plainEnvValue(value);
  if (direct !== undefined) return direct;
  if (value != null && typeof value === "object") {
    const record = value as { volumeId?: unknown; id?: unknown };
    return coerceBindingId(record.volumeId) ?? coerceBindingId(record.id);
  }
  return undefined;
};

export const collectBindingState = (
  bindings: readonly ResourceBinding<ServiceBinding>[],
) => {
  const active = bindings.filter(
    (binding: ResourceBinding<ServiceBinding> & { action?: string }) =>
      binding.action !== "delete",
  );
  const env = toEnvRecord(
    active
      .map((binding) => binding?.data?.env)
      .reduce<Record<string, any>>((acc, value) => ({ ...acc, ...value }), {}),
  );
  const mounts: MountSpec[] = [];
  const seen = new Set<string>();
  for (const binding of active) {
    for (const mount of binding?.data?.mounts ?? []) {
      const volumeId = coerceBindingId(mount.volumeId);
      if (volumeId === undefined) continue;
      const key = `${volumeId}:${mount.path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      mounts.push({ volumeId, path: mount.path });
    }
  }
  return { env, mounts };
};

export class FunctionBundleNotSingleFile extends Data.TaggedError(
  "Railway.FunctionBundleNotSingleFile",
)<{
  files: readonly string[];
}> {}

const decodeBundleText = (content: string | Uint8Array): string =>
  typeof content === "string" ? content : new TextDecoder().decode(content);

const IMPORT_SPEC =
  /(?:from|import)\s*\(\s*["']([^"']+)["']|(?:from|import)\s+["']([^"']+)["']/g;

const CANVAS_PINNED = new Set(["effect", "@effect/platform-bun"]);

/** Packages Railway must install; `@effect/platform-node` is stubbed. */
const skipCanvasPin = (root: string): boolean =>
  CANVAS_PINNED.has(root) ||
  root === "alchemy" ||
  root.startsWith("@effect/platform-node") ||
  root.startsWith("@distilled.cloud/");

const collectCanvasPackageRoots = (
  source: string,
  install: Readonly<Record<string, string>>,
): string[] => {
  const roots = new Set<string>(Object.keys(install));
  for (const match of source.matchAll(IMPORT_SPEC)) {
    const spec = match[1] ?? match[2];
    if (spec === undefined) continue;
    const root = parsePackageRootFromSpecifier(spec);
    if (root !== undefined && !skipCanvasPin(root)) roots.add(root);
  }
  return [...roots].sort();
};

const readPackageVersion = (name: string): string | undefined => {
  try {
    const req = createRequire(import.meta.url);
    const version = (req(`${name}/package.json`) as { version?: string })
      .version;
    return typeof version === "string" && version.length > 0
      ? version
      : undefined;
  } catch {
    return undefined;
  }
};

const pinImport = (name: string, version?: string): string => {
  const spec =
    version !== undefined && version.length > 0 && version !== "*"
      ? `${name}@${version}`
      : name;
  return `import ${JSON.stringify(spec)};`;
};

/**
 * Canvas wrapper that listens first, then import()s the bundled module.
 * Static `import "pkg@version"` pins are for Railway's AST installer —
 * `effect` is 4.x here, 3.x on npm without a pin. Extra pins come from
 * remaining external imports (`pg`, `drizzle-orm`, `@effect/sql-pg`).
 */
const wrapCanvasListener = (
  inner: string,
  install: Readonly<Record<string, string>> = {},
) =>
  Effect.sync(() => {
    const effectVersion = readPackageVersion("effect") ?? "latest";
    const bunVersion = readPackageVersion("@effect/platform-bun") ?? "latest";
    const extraPins = collectCanvasPackageRoots(inner, install).map((name) => {
      const requested = install[name];
      const version =
        requested !== undefined && requested !== "*"
          ? requested
          : readPackageVersion(name);
      return pinImport(name, version);
    });
    const pins = [
      pinImport("effect", effectVersion),
      pinImport("@effect/platform-bun", bunVersion),
      ...extraPins,
    ].join("\n");
    return `${pins}
const g = globalThis;
const port = Number(process.env.PORT ?? 3000);
g.__ALCHEMY_FUNCTION_FETCH__ ??= async () => new Response("");
Bun.serve({
  hostname: "0.0.0.0",
  port,
  fetch: (r) => g.__ALCHEMY_FUNCTION_FETCH__(r),
});
try {
  const innerUrl = new URL("./i.mjs", import.meta.url);
  await Bun.write(innerUrl, ${JSON.stringify(inner)});
  await import(innerUrl.href);
} catch (error) {
  g.__ALCHEMY_FUNCTION_FETCH__ = async () =>
    new Response(String(error), { status: 500 });
}
await new Promise(()=>{});
`;
  });

const isCanvasFunctionExternal = (moduleId: string): boolean => {
  if (moduleId.startsWith("@effect/platform-node")) return false;
  if (moduleId === "node:os") return false;
  return (
    moduleId === "effect" ||
    moduleId.startsWith("effect/") ||
    moduleId.startsWith("@effect/") ||
    moduleId.startsWith("node:") ||
    moduleId === "bun" ||
    moduleId.startsWith("bun:")
  );
};

const STUB_PLATFORM_NODE = "virtual:alchemy-stub-platform-node";

/** Functions run on Bun. Drop `@effect/platform-node` so Railway does not install it. */
const stubPlatformNodePlugin = (): rolldown.Plugin => ({
  name: "alchemy:stub-platform-node",
  resolveId: {
    filter: { id: /^@effect\/platform-node/ },
    handler() {
      return { id: STUB_PLATFORM_NODE, moduleSideEffects: false };
    },
  },
  load: {
    filter: { id: /^virtual:alchemy-stub-platform-node$/ },
    handler() {
      return { code: "export default {};\n", moduleType: "js" };
    },
  },
});

const STUB_NODE_OS = "virtual:alchemy-stub-node-os";

const stubNodeOsPlugin = (): rolldown.Plugin => ({
  name: "alchemy:stub-node-os",
  resolveId: {
    filter: { id: /^node:os$/ },
    handler() {
      return { id: STUB_NODE_OS, moduleSideEffects: false };
    },
  },
  load: {
    filter: { id: /^virtual:alchemy-stub-node-os$/ },
    handler() {
      return {
        code: [
          "export const homedir = () => '/';",
          "export const cpus = () => [];",
          "export const platform = () => 'linux';",
          "export const arch = () => 'x64';",
          "export const tmpdir = () => '/tmp';",
          "export const hostname = () => 'railway';",
          "export const type = () => 'Linux';",
          "export const release = () => '';",
          "export const endianness = () => 'LE';",
          "export default { homedir, cpus, platform, arch, tmpdir, hostname, type, release, endianness };",
          "",
        ].join("\n"),
        moduleType: "js",
      };
    },
  },
});

const createBundleProgram = (
  virtualEntryPlugin: (
    content: (importPath: string) => string,
  ) => rolldown.Plugin,
  options?: {
    output?: Partial<rolldown.OutputOptions>;
    /**
     * Extra unresolved specifiers to leave as imports. Canvas Functions
     * auto-install npm packages; leaving `effect` external keeps the
     * encoded start command under 96KB.
     */
    canvasExternals?: boolean;
    bootstrap?: (handler: string) => (importPath: string) => string;
  },
) =>
  Effect.fn(function* (props: HostedProgramProps) {
    const handler = props.handler ?? "default";
    const realMain = yield* resolveMainPath(props.main);
    const cwd = yield* findCwdForBundle(realMain);
    const bootstrap = (options?.bootstrap ?? makeBunBootstrap)(handler);
    const requested = yield* normalizeInstallTargets(props.build?.install);
    const installRoots = new Set(Object.keys(requested));
    const configuredExternal = props.build?.input?.external;
    const output = options?.output;
    const canvasExternals = options?.canvasExternals === true;

    const buildBundle = Effect.fn(function* (
      entry: string,
      plugins?: rolldown.RolldownPluginOption,
    ) {
      return yield* Bundle.build(
        {
          ...props.build?.input,
          input: entry,
          cwd,
          platform: "node",
          external: (moduleId, parentId, isResolved) => {
            if (moduleId === "bun" || moduleId.startsWith("bun:")) return true;
            if (canvasExternals && isCanvasFunctionExternal(moduleId)) {
              return true;
            }
            for (const root of installRoots) {
              if (matchesPackageRoot(moduleId, root)) return true;
            }
            return matchesConfiguredExternal(
              configuredExternal,
              moduleId,
              parentId,
              isResolved,
            );
          },
          resolve: {
            conditionNames: ["bun", "import", "module", "default"],
            ...props.build?.input?.resolve,
          },
          plugins: [
            canvasExternals ? stubPlatformNodePlugin() : undefined,
            canvasExternals ? stubNodeOsPlugin() : undefined,
            props.build?.input?.plugins,
            plugins,
          ],
        },
        {
          ...props.build?.output,
          ...output,
          format: "esm",
          sourcemap:
            output?.sourcemap ?? props.build?.output?.sourcemap ?? false,
          entryFileNames: "index.mjs",
          strictExecutionOrder: true,
          keepNames: true,
        },
        props.build,
      );
    });

    const bundleOutput = props.isExternal
      ? yield* buildBundle(realMain)
      : yield* buildBundle(realMain, virtualEntryPlugin(bootstrap));

    const files = bundleOutput.files.map((file) => ({
      path: file.path,
      content:
        typeof file.content === "string"
          ? new TextEncoder().encode(file.content)
          : file.content,
    }));

    return { files, hash: bundleOutput.hash };
  });

/**
 * Bundle an Effect-native Railway.Function into a single TypeScript/JS
 * file for the canvas function runtime. No Docker. No registry.
 */
export const createRailwayFunctionSupport = ({
  stackName,
  stage,
  virtualEntryPlugin,
}: {
  stackName: string;
  stage: string;
  virtualEntryPlugin: (
    content: (importPath: string) => string,
  ) => rolldown.Plugin;
}) => {
  const alchemyEnv = {
    ALCHEMY_STACK_NAME: stackName,
    ALCHEMY_STAGE: stage,
    ALCHEMY_PHASE: "runtime",
  };

  const bundleProgram = createBundleProgram(virtualEntryPlugin, {
    canvasExternals: true,
    bootstrap: makeFunctionBootstrap,
    output: {
      // dce-only (Bundle.build default) keeps `import … from "effect/…"`
      // readable so Railway's AST installer sees Effect 4 pins. Full
      // minify still 502s: npm `effect` is 3.x without those subpaths.
      codeSplitting: false,
    },
  });

  const bundleToSource = Effect.fn(function* (props: HostedProgramProps) {
    const bundled = yield* bundleProgram(props);
    if (bundled.files.length !== 1) {
      return yield* new FunctionBundleNotSingleFile({
        files: bundled.files.map((file) => file.path),
      });
    }
    const inner = decodeBundleText(bundled.files[0]!.content);
    const install = yield* normalizeInstallTargets(props.build?.install);
    const source = yield* wrapCanvasListener(inner, install);
    const hash = yield* sha256(source);
    return { source, hash };
  });

  const hash = Effect.fn(function* (props: HostedProgramProps) {
    const bundled = yield* bundleToSource(props);
    return bundled.hash;
  });

  return { alchemyEnv, bundleProgram, bundleToSource, hash };
};

const sanitizeImageRepo = (id: string): string => {
  const lowered = id
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return lowered.length === 0 ? "service" : lowered;
};

const generateDockerfile = (
  props: HostedProgramProps,
  hasChunks: boolean,
  install?: Record<string, string>,
) => {
  const port = props.port ?? DEFAULT_PORT;
  const lines = [`FROM ${props.image ?? DEFAULT_BASE_IMAGE}`, `WORKDIR /app`];
  if (install !== undefined && Object.keys(install).length > 0) {
    lines.push(
      `COPY package.json /app/package.json`,
      `RUN bun install --production`,
    );
  }
  lines.push(`COPY index.mjs /app/index.mjs`);
  if (hasChunks) {
    lines.push(`COPY *.js /app/`);
  }
  lines.push(
    `ENV PORT=${String(port)}`,
    `EXPOSE ${String(port)}`,
    `ENTRYPOINT ["bun", "/app/index.mjs"]`,
  );
  return `${lines.join("\n")}\n`;
};

const installManifest = (dependencies: Record<string, string>) =>
  `${JSON.stringify(
    { private: true, type: "module", dependencies },
    null,
    2,
  )}\n`;

const registryHost = (registry: string): string => {
  const trimmed = registry.replace(/\/+$/, "");
  const host = trimmed.split("/")[0] ?? trimmed;
  if (host === "docker.io" || host === "index.docker.io") {
    return "https://index.docker.io/v1/";
  }
  if (host.includes(".")) return host;
  return "https://index.docker.io/v1/";
};

export const createRailwayHostedSupport = ({
  stackName,
  stage,
  virtualEntryPlugin,
  docker,
  dotAlchemy,
}: {
  stackName: string;
  stage: string;
  virtualEntryPlugin: (
    content: (importPath: string) => string,
  ) => rolldown.Plugin;
  docker: Docker["Service"];
  dotAlchemy: string;
}) => {
  const alchemyEnv = {
    ALCHEMY_STACK_NAME: stackName,
    ALCHEMY_STAGE: stage,
    ALCHEMY_PHASE: "runtime",
  };

  const bundleProgram = createBundleProgram(virtualEntryPlugin);

  const computeCodeHash = Effect.fn(function* (props: HostedProgramProps) {
    const bundled = yield* bundleProgram(props);
    const realMain = yield* resolveMainPath(props.main);
    const cwd = yield* findCwdForBundle(realMain);
    const requested = yield* normalizeInstallTargets(props.build?.install);
    const identity =
      Object.keys(requested).length > 0
        ? yield* resolvePackageInstallIdentity({ cwd, requested })
        : undefined;
    const install =
      identity !== undefined && Object.keys(identity.resolved).length > 0
        ? identity.resolved
        : undefined;
    const packageJson =
      install === undefined ? undefined : installManifest(install);
    const dockerfile = generateDockerfile(
      props,
      bundled.files.length > 1,
      install,
    );
    const codeHash = (yield* sha256Object({
      bundleHash: bundled.hash,
      dockerfile,
      packageJson,
    })).slice(0, 16);
    return { bundled, dockerfile, codeHash, packageJson };
  });

  const imageExists = (imageRef: string) =>
    docker.image.inspect(imageRef).pipe(
      Effect.map(() => true),
      Effect.catchReason("PlatformError", "NotFound", () =>
        Effect.succeed(false),
      ),
    );

  const pushBackoff = Schedule.exponential("2 seconds");

  /**
   * Bundle `main`, content-hash the image, build it when missing, and
   * push to `{registry}/{logicalId}:{hash}`. When `previousHash` matches,
   * skip build and push.
   */
  const resolveImage = Effect.fn(function* (input: {
    id: string;
    props: HostedProgramProps;
    previousHash?: string;
    session?: { note: (message: string) => Effect.Effect<void> };
  }) {
    const registry = input.props.registry?.replace(/\/+$/, "");
    if (registry === undefined || registry.length === 0) {
      return yield* new RegistryRequired({
        message:
          "Railway.Service with `main` requires `registry` (GHCR / Docker Hub prefix Railway can pull).",
      });
    }
    const note = input.session?.note ?? ((_message: string) => Effect.void);
    yield* note(`Bundling ${input.id} program...`);
    const { bundled, dockerfile, codeHash, packageJson } =
      yield* computeCodeHash(input.props);
    const repo = sanitizeImageRepo(input.id);
    const imageRef = `${registry}/${repo}:${codeHash}`;

    if (input.previousHash === codeHash) {
      return { imageRef, codeHash, registryCredentials: undefined };
    }

    if (!(yield* imageExists(imageRef))) {
      const realMain = yield* resolveMainPath(input.props.main);
      const contextDir = yield* getStableContextDir(
        realMain,
        dotAlchemy,
        `${input.id}-image`,
      );
      const files = bundled.files.map((file, index) => ({
        path: index === 0 ? "index.mjs" : file.path,
        content: file.content,
      }));
      if (packageJson !== undefined) {
        files.push({
          path: "package.json",
          content: new TextEncoder().encode(packageJson),
        });
      }
      yield* docker.materialize({
        context: contextDir,
        dockerfile,
        files,
      });
      yield* note(`Building container image ${imageRef}...`);
      yield* docker.image.build({
        context: contextDir,
        tag: imageRef,
        platform: MACHINE_PLATFORM,
      });
      yield* note(`Built ${imageRef}`);
    }

    const username = yield* Effect.sync(
      () =>
        process.env.RAILWAY_REGISTRY_USERNAME ??
        process.env.GITHUB_ACTOR ??
        process.env.DOCKERHUB_USERNAME,
    );
    const passwordPlain = yield* Effect.sync(
      () =>
        process.env.RAILWAY_REGISTRY_PASSWORD ??
        process.env.GITHUB_TOKEN ??
        process.env.DOCKERHUB_TOKEN ??
        process.env.DOCKER_PASSWORD,
    );
    if (
      username === undefined ||
      username.length === 0 ||
      passwordPlain === undefined ||
      passwordPlain.length === 0
    ) {
      return yield* new RegistryCredentialsMissing({ registry });
    }

    yield* note(`Pushing ${imageRef}...`);
    yield* docker.image
      .push(imageRef, {
        server: registryHost(registry),
        username,
        password: Redacted.make(passwordPlain),
      })
      .pipe(
        Effect.retry({
          times: 3,
          schedule: pushBackoff,
        }),
      );
    yield* note(`Pushed ${imageRef}`);
    return {
      imageRef,
      codeHash,
      registryCredentials: { username, password: passwordPlain },
    };
  });

  const hash = Effect.fn(function* (props: HostedProgramProps) {
    const { codeHash } = yield* computeCodeHash(props);
    return codeHash;
  });

  return {
    alchemyEnv,
    bundleProgram,
    computeCodeHash,
    resolveImage,
    hash,
  };
};
