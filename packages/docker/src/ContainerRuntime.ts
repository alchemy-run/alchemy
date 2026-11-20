import { fileURLToPath } from "node:url";
import { BUN_CONDITION_NAMES, NODE_CONDITION_NAMES } from "alchemy/Bundle/Bundle";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import { makeJobBootstrap, makeServerBootstrap } from "./internal/ContainerBunBootstrap.ts";

export interface ContainerRuntimeConfig {
  /** Base image used when the workload supplies no image or Dockerfile. */
  readonly baseImage: string;
  /** Arguments before the generated bundle path, for example `["node"]`. */
  readonly command: readonly [string, ...string[]];
  /** Package export conditions for the generated bundle. */
  readonly conditions: readonly string[];
  /** Runtime-provided imports, for example `["bun", "bun:*"]`. */
  readonly external?: readonly string[];
  /** Command that installs packages the application leaves external. */
  readonly installPackages?: readonly [string, ...string[]];
  /**
   * Absolute path or file URL to a module exporting the `services` and
   * `httpServer` Effect layers. The module is bundled into the image.
   */
  readonly platformModule: string;
  /** Required when the runtime will be mounted into a sandbox's existing image. */
  readonly portableAgent?: PortableAgentRuntime;
}

/** A musl-based image whose executable and libraries can be mounted into another container. */
export interface PortableAgentRuntime {
  readonly baseImage: string;
  readonly executable: string;
  /** Libraries to copy from the image. When omitted, discover them with `ldd`. */
  readonly libraries?: readonly string[];
  /** Interactive terminal implementation available in the portable runtime. */
  readonly pty?: "bun";
}

export interface ContainerRuntimeSettings extends ContainerRuntimeConfig {
  readonly preset?: "bun" | "node";
  /** Temporary process templates for hosts preserving existing Bun image hashes. */
  readonly compatibilityBootstrap?: Readonly<
    Record<"server" | "job", (handler: string) => (importPath: string) => string>
  >;
}

const bunContainerRuntime = (): ContainerRuntimeSettings => ({
  preset: "bun",
  baseImage: "oven/bun:1",
  command: ["bun"],
  conditions: BUN_CONDITION_NAMES,
  external: ["bun", "bun:*"],
  installPackages: ["bun", "add"],
  platformModule: import.meta.resolve("alchemy/Runtime/ContainerBun"),
  compatibilityBootstrap: { server: makeServerBootstrap, job: makeJobBootstrap },
  portableAgent: {
    baseImage: "oven/bun:1-alpine",
    executable: "/usr/local/bin/bun",
    libraries: ["/usr/lib/libstdc++.so.6", "/usr/lib/libgcc_s.so.1"],
    pty: "bun",
  },
});

const nodeContainerRuntime = (): ContainerRuntimeSettings => ({
  preset: "node",
  baseImage: "node:26-slim",
  command: ["node"],
  conditions: NODE_CONDITION_NAMES,
  installPackages: ["npm", "install"],
  platformModule: import.meta.resolve("alchemy/Runtime/ContainerNode"),
  portableAgent: { baseImage: "node:26-alpine", executable: "/usr/local/bin/node" },
});

const runtime = Context.Reference<ContainerRuntimeSettings>("Docker.ContainerRuntime", {
  defaultValue: bunContainerRuntime,
});

/**
 * Selects how Alchemy bundles and starts programs in generated container
 * images. Provide it to the Docker or Kubernetes providers.
 */
export const ContainerRuntime = Object.assign(runtime, {
  custom: (config: ContainerRuntimeConfig) =>
    Layer.succeed(runtime, { ...config, preset: undefined, compatibilityBootstrap: undefined }),

  /** Build and run the workload with Bun. */
  bun: Layer.sync(runtime, bunContainerRuntime),

  /**
   * Build and run the workload with Node.js. The project must install
   * `@effect/platform-node` to bundle the platform services.
   */
  node: Layer.sync(runtime, nodeContainerRuntime),
});

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
