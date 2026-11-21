import { fileURLToPath } from "node:url";
import { BUN_CONDITION_NAMES, NODE_CONDITION_NAMES } from "alchemy/Bundle/Bundle";
import { NODE_PTY_PACKAGE } from "alchemy/Runtime/TerminalNode";
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
  /** Command that installs packages the application leaves external, for example `["npm", "install"]`. */
  readonly installPackages: readonly [string, ...string[]];
  /**
   * Absolute path or file URL to a module exporting the `services` and
   * `httpServer` Effect layers. The module is bundled into the image.
   */
  readonly platformModule: string;
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
});

const nodeContainerRuntime = (): ContainerRuntimeSettings => ({
  preset: "node",
  baseImage: "node:26-slim",
  command: ["node"],
  conditions: NODE_CONDITION_NAMES,
  // Installed into the image by hosts whose program opens terminals.
  external: [NODE_PTY_PACKAGE],
  installPackages: ["npm", "install"],
  platformModule: import.meta.resolve("alchemy/Runtime/ContainerNode"),
});

const runtime = Context.Reference<ContainerRuntimeSettings>("Docker.ContainerRuntime", {
  defaultValue: nodeContainerRuntime,
});

/**
 * Selects how Alchemy bundles and starts programs in generated container
 * images. Programs run on Node.js 26 (`node:26-slim`) unless you provide
 * another runtime to the providers.
 *
 * ```ts
 * // Run bundled programs on Bun instead
 * providers: Kubernetes.providers().pipe(Layer.provide(ContainerRuntime.bun)),
 * ```
 *
 * The project installs the platform package of the runtime it selects:
 * `@effect/platform-node` for Node.js, `@effect/platform-bun` for Bun.
 */
export const ContainerRuntime = Object.assign(runtime, {
  custom: (config: ContainerRuntimeConfig) =>
    Layer.succeed(runtime, { ...config, preset: undefined, compatibilityBootstrap: undefined }),

  /**
   * Build and run the workload with Bun on `oven/bun:1`. The project must
   * install `@effect/platform-bun`. Images match the ones Alchemy built
   * before Node.js became the default, so selecting Bun keeps existing
   * deployments from rebuilding.
   */
  bun: Layer.sync(runtime, bunContainerRuntime),

  /**
   * Build and run the workload with Node.js 26 on `node:26-slim` (the
   * default). The project must install `@effect/platform-node`.
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
