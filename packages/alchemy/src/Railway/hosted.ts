import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import type * as rolldown from "rolldown";
import * as Bundle from "../Bundle/Bundle.ts";
import {
  matchesPackageRoot,
  normalizeInstallTargets,
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
import { Self } from "../Self.ts";
import {
  createContainerRuntimeContext,
  type HostRuntimeContext,
} from "../Server/Process.ts";
import { sha256Object } from "../Util/sha256.ts";
import type { MountSpec, ServiceBinding } from "./MountVolume.ts";

export type RailwayHostRuntimeContext = HostRuntimeContext;

export const createRailwayHostRuntimeContext = createContainerRuntimeContext;

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
      if (volumeId === undefined || seen.has(mount.path)) continue;
      seen.add(mount.path);
      mounts.push({ volumeId, path: mount.path });
    }
  }
  return { env, mounts };
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

  const bundleProgram = Effect.fn(function* (props: HostedProgramProps) {
    const handler = props.handler ?? "default";
    const realMain = yield* resolveMainPath(props.main);
    const cwd = yield* findCwdForBundle(realMain);
    const bootstrap = makeBunBootstrap(handler);
    const requested = yield* normalizeInstallTargets(props.build?.install);
    const installRoots = new Set(Object.keys(requested));
    const configuredExternal = props.build?.input?.external;

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
          plugins: [props.build?.input?.plugins, plugins],
        },
        {
          ...props.build?.output,
          format: "esm",
          sourcemap: props.build?.output?.sourcemap ?? false,
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
