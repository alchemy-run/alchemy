import { fileURLToPath } from "node:url";
import { BUN_CONDITION_NAMES, NODE_CONDITION_NAMES } from "alchemy/Bundle/Bundle";
import { NODE_PTY_PACKAGE } from "alchemy/Runtime/TerminalNode";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { makeJobBootstrap, makeServerBootstrap } from "./internal/ContainerBunBootstrap.ts";

/**
 * The runtime a bundled program (`main`) runs on: `node` or `bun`, optionally
 * followed by a version. The version is the base image's tag, so it can be
 * as precise as the release you need:
 *
 * | `runtime` | base image |
 * | --- | --- |
 * | `"node"`, `"node26"` | `node:26-slim` |
 * | `"node24"` | `node:24-slim` |
 * | `"node26.13.1"` | `node:26.13.1-slim` |
 * | `"bun"`, `"bun1"` | `oven/bun:1` |
 * | `"bun1.3"` | `oven/bun:1.3` |
 * | `"bun1.3.13"` | `oven/bun:1.3.13` |
 *
 * Bun changes between minor and patch releases, so pin at least the minor
 * (`"bun1.3"`), or the exact release when one breaks you (`"bun1.3.13"`).
 * Tags still move when an image is rebuilt over a new OS layer; for a
 * byte-identical image, set your own `image` digest beside `runtime`.
 */
export type ContainerRuntime =
  | "node"
  | "bun"
  | `node${number}`
  | `node${number}.${number}`
  | `bun${number}`
  | `bun${number}.${number}`;

/** The runtime bundled programs use when a resource sets none. */
export const DEFAULT_CONTAINER_RUNTIME = "node" satisfies ContainerRuntime;

/** The Node.js major `"node"` means. */
const NODE_DEFAULT_VERSION = "26";
/** The Bun tag `"bun"` means: the newest 1.x release. */
const BUN_DEFAULT_VERSION = "1";

/** How Alchemy bundles and starts a program on one runtime. */
export interface ContainerRuntimeSettings {
  readonly preset: "bun" | "node";
  /** Base image used when the workload supplies no image or Dockerfile. */
  readonly baseImage: string;
  /** Arguments before the generated bundle path, for example `["node"]`. */
  readonly command: readonly [string, ...string[]];
  /** Package export conditions for the generated bundle. */
  readonly conditions: readonly string[];
  /** Imports the runtime provides or the image installs beside the bundle. */
  readonly external?: readonly string[];
  /** Command that installs packages the application leaves external, for example `["npm", "install"]`. */
  readonly installPackages: readonly [string, ...string[]];
  /**
   * Absolute path or file URL to a module exporting the `services` and
   * `httpServer` Effect layers. The module is bundled into the image.
   */
  readonly platformModule: string;
  /**
   * Bun's own process templates. They keep the images Alchemy built before
   * the shared process entry existed, so Bun deployments don't rebuild.
   */
  readonly compatibilityBootstrap?: Readonly<
    Record<"server" | "job", (handler: string) => (importPath: string) => string>
  >;
}

/** A `runtime` that isn't `node` or `bun` followed by an optional version. */
export class InvalidContainerRuntime extends Data.TaggedError("InvalidContainerRuntime")<{
  readonly runtime: string;
  readonly message: string;
}> {}

const RUNTIME_PATTERN = /^(node|bun)(\d+(?:\.\d+){0,2})?$/;

const bunSettings = (version: string): ContainerRuntimeSettings => ({
  preset: "bun",
  baseImage: `oven/bun:${version}`,
  command: ["bun"],
  conditions: BUN_CONDITION_NAMES,
  external: ["bun", "bun:*"],
  installPackages: ["bun", "add"],
  platformModule: import.meta.resolve("alchemy/Runtime/ContainerBun"),
  compatibilityBootstrap: { server: makeServerBootstrap, job: makeJobBootstrap },
});

const nodeSettings = (version: string): ContainerRuntimeSettings => ({
  preset: "node",
  baseImage: `node:${version}-slim`,
  command: ["node"],
  conditions: NODE_CONDITION_NAMES,
  // Installed into the image by hosts whose program opens terminals.
  external: [NODE_PTY_PACKAGE],
  installPackages: ["npm", "install"],
  platformModule: import.meta.resolve("alchemy/Runtime/ContainerNode"),
});

/**
 * The settings for a resource's `runtime`, or for
 * {@link DEFAULT_CONTAINER_RUNTIME} when it sets none.
 */
export const resolveContainerRuntime = (
  runtime: ContainerRuntime | undefined,
): Effect.Effect<ContainerRuntimeSettings, InvalidContainerRuntime> => {
  const name = runtime ?? DEFAULT_CONTAINER_RUNTIME;
  const match = RUNTIME_PATTERN.exec(name);
  if (match === null) {
    return Effect.fail(
      new InvalidContainerRuntime({
        runtime: name,
        message: `Unknown container runtime "${name}". Use "node" or "bun", optionally with a version: "node26", "bun1.3", "bun1.3.13".`,
      }),
    );
  }
  const [, kind, version] = match;
  return Effect.succeed(
    kind === "bun"
      ? bunSettings(version ?? BUN_DEFAULT_VERSION)
      : nodeSettings(version ?? NODE_DEFAULT_VERSION),
  );
};

/** The base image of {@link DEFAULT_CONTAINER_RUNTIME}. */
export const DEFAULT_CONTAINER_BASE_IMAGE = nodeSettings(NODE_DEFAULT_VERSION).baseImage;

/** The settings of the runtime the image-only sandbox agent runs on. */
export const SANDBOX_AGENT_RUNTIME = bunSettings(BUN_DEFAULT_VERSION);

export const containerPlatformModulePath = (module: string) =>
  module.startsWith("file:") ? fileURLToPath(module) : module;

export const makeContainerBootstrap =
  (
    platformModule: string,
    bootstrapModule: string,
    handler: string,
    mode: "server" | "job",
    options?: { readonly deferEntrypointImport?: boolean },
  ) =>
  (importPath: string) =>
    `
import { bootstrap } from ${JSON.stringify(bootstrapModule)};
import * as platform from ${JSON.stringify(containerPlatformModulePath(platformModule))};
${
  options?.deferEntrypointImport
    ? `\nglobalThis.__ALCHEMY_RUNTIME__ = true;\nconst { ${handler}: entrypoint } = await import(${JSON.stringify(importPath)});`
    : `import { ${handler} as entrypoint } from ${JSON.stringify(importPath)};`
}

await bootstrap(entrypoint, platform, ${JSON.stringify(mode)});
`;
