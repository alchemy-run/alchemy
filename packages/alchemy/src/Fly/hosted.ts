import type { FlyMachineService } from "@distilled.cloud/fly-io/machines";
import * as machines from "@distilled.cloud/fly-io/machines";
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
import type { DiskSpec, ServiceBinding } from "./MountVolume.ts";

export type FlyHostRuntimeContext = HostRuntimeContext;

export const createFlyHostRuntimeContext = createContainerRuntimeContext;

export const FLY_REGISTRY = "registry.fly.io";
export const DEFAULT_BASE_IMAGE = "oven/bun:1";
export const DEFAULT_PORT = 3000;
export const MACHINE_PLATFORM = "linux/amd64";

export interface FlyBuildOptions extends Bundle.BundleConfig {
  /**
   * Native or Node-only packages to install into the Machine image with
   * `bun install` instead of bundling them. `pg` is CommonJS: Rolldown's
   * interop turns `Client` into a namespace (`The superclass is not a
   * constructor`). Same `build.install` shape as Lambda.
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
  image?: string;
  env?: Record<string, any>;
  isExternal?: boolean;
  build?: FlyBuildOptions;
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

export class DeployTokenMissing extends Data.TaggedError(
  "Fly.DeployTokenMissing",
)<{
  appName: string;
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

console.log("Fly service bootstrap starting...");
await Effect.runPromise(program).catch((err) => {
  console.error("Fly service bootstrap failed:", err);
  process.exit(1);
});
`;

/** Flatten a binding/env leaf into a machine env string. Unwraps Redacted. */
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

const coerceBindingName = (value: unknown): string | undefined => {
  const direct = plainEnvValue(value);
  if (direct !== undefined) return direct;
  if (value != null && typeof value === "object") {
    const record = value as { name?: unknown; id?: unknown; addOnId?: unknown };
    return (
      coerceBindingName(record.name) ??
      coerceBindingName(record.id) ??
      coerceBindingName(record.addOnId)
    );
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
  const mounts: DiskSpec[] = [];
  const seen = new Set<string>();
  const redis: { name: string; id?: string }[] = [];
  const buckets: { name: string; id?: string }[] = [];
  const postgres: { clusterId: string; variableName?: string }[] = [];
  for (const binding of active) {
    for (const mount of binding?.data?.mounts ?? []) {
      if (seen.has(mount.path)) continue;
      seen.add(mount.path);
      mounts.push(mount);
    }
    const attached = binding?.data?.redis;
    const redisName = coerceBindingName(attached?.name);
    const redisId = coerceBindingName(attached?.id);
    if (redisName !== undefined || redisId !== undefined) {
      redis.push({
        name: redisName ?? "",
        id: redisId,
      });
    }
    const bucket = binding?.data?.bucket as
      | {
          name?: unknown;
          id?: unknown;
          addOnId?: unknown;
          accessKeyId?: unknown;
          secretAccessKey?: unknown;
          endpoint?: unknown;
          region?: unknown;
          bucketName?: unknown;
        }
      | undefined;
    const bucketName = coerceBindingName(bucket?.name);
    const bucketId =
      coerceBindingName(bucket?.id) ?? coerceBindingName(bucket?.addOnId);
    if (bucketName !== undefined || bucketId !== undefined) {
      buckets.push({
        name: bucketName ?? "",
        id: bucketId,
      });
    }
    if (bucket !== undefined) {
      Object.assign(
        env,
        toEnvRecord({
          AWS_ACCESS_KEY_ID: bucket.accessKeyId,
          AWS_SECRET_ACCESS_KEY: bucket.secretAccessKey,
          AWS_ENDPOINT_URL_S3: bucket.endpoint,
          AWS_ENDPOINT_URL: bucket.endpoint,
          AWS_REGION: bucket.region,
          BUCKET_NAME: bucket.bucketName ?? bucket.name,
        }),
      );
    }
    const pg = binding?.data?.postgres;
    const clusterId = coerceBindingName(pg?.clusterId);
    if (clusterId !== undefined) {
      postgres.push({
        clusterId,
        variableName:
          typeof pg?.variableName === "string" && pg.variableName.length > 0
            ? pg.variableName
            : undefined,
      });
    }
  }
  return { env, mounts, redis, buckets, postgres };
};

export const defaultHttpServices = (
  port: number,
  count = 1,
): FlyMachineService[] => [
  {
    protocol: "tcp",
    internal_port: port,
    autostart: true,
    autostop: "off",
    min_machines_running: count,
    ports: [
      { port: 80, handlers: ["http"], force_https: true },
      { port: 443, handlers: ["tls", "http"] },
    ],
  },
];

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

export const createFlyHostedSupport = ({
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
   * push to `registry.fly.io/{appName}:{logicalId}-{hash}` using an
   * app deploy token. When `previousHash` matches, skip build and push.
   *
   * Fly's registry is app-scoped (`/v2/{app}/...`). A nested
   * `{app}/{image}` repository 404s on blob upload.
   */
  const resolveImage = Effect.fn(function* (input: {
    id: string;
    appName: string;
    props: HostedProgramProps;
    previousHash?: string;
    session?: { note: (message: string) => Effect.Effect<void> };
  }) {
    const note = input.session?.note ?? ((_message: string) => Effect.void);
    yield* note(`Bundling ${input.id} program...`);
    const { bundled, dockerfile, codeHash, packageJson } =
      yield* computeCodeHash(input.props);
    const repo = sanitizeImageRepo(input.id);
    const imageRef = `${FLY_REGISTRY}/${input.appName}:${repo}-${codeHash}`;

    if (input.previousHash === codeHash) {
      return { imageRef, codeHash };
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

    const minted = yield* machines.createAppDeployToken({
      app_name: input.appName,
    });
    const token = minted.token;
    if (token === undefined || token.length === 0) {
      return yield* new DeployTokenMissing({ appName: input.appName });
    }

    yield* note(`Pushing ${imageRef}...`);
    yield* docker.image
      .push(imageRef, {
        server: FLY_REGISTRY,
        username: "x",
        password: Redacted.make(token),
      })
      .pipe(
        Effect.retry({
          times: 3,
          schedule: pushBackoff,
        }),
      );
    yield* note(`Pushed ${imageRef}`);
    return { imageRef, codeHash };
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

/**
 * Bundle a Sprite program the same way {@link createFlyHostedSupport}
 * bundles a Service — rolldown + bun bootstrap — without building a
 * Docker image. The provider writes the files onto the Sprite.
 */
export const createSpriteHostedSupport = ({
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

  const bundleProgram = Effect.fn(function* (props: HostedProgramProps) {
    const handler = props.handler ?? "default";
    const realMain = yield* resolveMainPath(props.main);
    const cwd = yield* findCwdForBundle(realMain);
    const bootstrap = makeBunBootstrap(handler);

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
          external: [
            "bun",
            "bun:*",
            ...((props.build?.input?.external as string[] | undefined) ?? []),
          ],
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
          minify: props.build?.output?.minify ?? false,
          entryFileNames: "index.mjs",
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

  const hash = Effect.fn(function* (props: HostedProgramProps) {
    const bundled = yield* bundleProgram(props);
    return (yield* sha256Object({ bundleHash: bundled.hash })).slice(0, 16);
  });

  return { alchemyEnv, bundleProgram, hash };
};
