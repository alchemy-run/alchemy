import * as NodeFs from "node:fs/promises";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";
import { cloudflare as officialCloudflare } from "@cloudflare/vite-plugin";
import * as vite from "vite";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import cloudflareVitePlugin from "../../plugin.ts";
import { AHEAD_OF_RELEASE_BUILT_IN_MODULES } from "./ahead-of-release.ts";

// Differential conformance: the same project resolved with
// `@cloudflare/vite-plugin` and with Alchemy's plugin must look the same to
// the frameworks and plugins that read the resolved Vite config.

const COMPATIBILITY_DATE = "2026-03-17";

let root: string;

beforeAll(async () => {
  root = await NodeFs.realpath(
    await NodeFs.mkdtemp(NodePath.join(NodeOs.tmpdir(), "alchemy-vite-parity-")),
  );
  await NodeFs.mkdir(NodePath.join(root, "src"));
  await NodeFs.writeFile(
    NodePath.join(root, "src/index.ts"),
    "export default { fetch: () => new Response('ok') };",
  );
  await NodeFs.writeFile(NodePath.join(root, "package.json"), JSON.stringify({ type: "module" }));
});

afterAll(async () => {
  await NodeFs.rm(root, { recursive: true, force: true });
});

const resolve = (
  plugins: vite.PluginOption,
  command: "serve" | "build",
  userConfig: vite.InlineConfig = {},
) =>
  vite.resolveConfig(
    { ...userConfig, configFile: false, root, logLevel: "silent", plugins: [plugins] },
    command,
  );

const official = (flags: Array<string>) =>
  officialCloudflare({
    inspectorPort: false,
    persistState: false,
    types: { generate: false },
    config: (loaded) => ({
      ...loaded,
      worker: {
        ...loaded.worker,
        name: "worker",
        entrypoint: "./src/index.ts",
        compatibilityDate: COMPATIBILITY_DATE,
        compatibilityFlags: flags,
      },
    }),
  });

const alchemy = (flags: Array<string>) =>
  cloudflareVitePlugin({
    main: "./src/index.ts",
    compatibilityDate: COMPATIBILITY_DATE,
    compatibilityFlags: flags,
  });

// Built-ins ported ahead of the installed release are left out on both sides.
const sorted = (values: ReadonlyArray<unknown> | undefined) =>
  [...(values ?? [])]
    .map((value) => String(value))
    .filter((value) => !AHEAD_OF_RELEASE_BUILT_IN_MODULES.includes(value))
    .sort();

// Not compared: `build.outDir`. v2 builds every environment into Build Output
// under `.cloudflare/output/v1` for `cf deploy` and ignores the user's
// `build.outDir`. Alchemy deploys from Vite's own layout, so it keeps
// `<outDir>/<environment>`; "keeps Vite's output directories" pins that.

/** What a framework can observe of a Worker environment's resolved options. */
const workerEnvironment = (config: vite.ResolvedConfig) => {
  const environment = config.environments.ssr!;
  const build = environment.build;
  const rolldown = build.rolldownOptions ?? {};
  const optimizeDeps = environment.optimizeDeps;
  const optimizeRolldown = (optimizeDeps.rolldownOptions ?? {}) as {
    platform?: string;
    resolve?: { conditionNames?: Array<string>; extensions?: Array<string> };
    transform?: { target?: unknown; define?: Record<string, string> };
  };
  return {
    resolve: {
      conditions: environment.resolve.conditions,
      noExternal: environment.resolve.noExternal,
      builtins: sorted(environment.resolve.builtins),
      external: environment.resolve.external,
    },
    define: environment.define,
    keepProcessEnv: environment.keepProcessEnv,
    build: {
      target: build.target,
      cssTarget: build.cssTarget,
      emitAssets: build.emitAssets,
      manifest: build.manifest,
      sourcemap: build.sourcemap,
      copyPublicDir: build.copyPublicDir,
      ssr: build.ssr,
      inputNames: Object.keys((rolldown.input as Record<string, string> | undefined) ?? {}),
      preserveEntrySignatures: rolldown.preserveEntrySignatures,
      platform: rolldown.platform,
      extensions: rolldown.resolve?.extensions,
    },
    optimizeDeps: {
      noDiscovery: optimizeDeps.noDiscovery,
      ignoreOutdatedRequests: optimizeDeps.ignoreOutdatedRequests,
      exclude: sorted(optimizeDeps.exclude),
      platform: optimizeRolldown.platform,
      conditionNames: optimizeRolldown.resolve?.conditionNames,
      extensions: optimizeRolldown.resolve?.extensions,
      target: optimizeRolldown.transform?.target,
      define: optimizeRolldown.transform?.define,
    },
  };
};

const clientEnvironment = (config: vite.ResolvedConfig) => ({
  exclude: sorted(config.environments.client!.optimizeDeps.exclude),
});

describe.each([
  { name: "without nodejs_compat", flags: [] },
  { name: "with nodejs_compat", flags: ["nodejs_compat"] },
  { name: "with nodejs_als", flags: ["nodejs_als"] },
])("resolved config matches @cloudflare/vite-plugin $name", ({ flags }) => {
  it.each(["serve", "build"] as const)("%s: the Worker environment", async (command) => {
    const expected = workerEnvironment(await resolve(official(flags), command));
    const actual = workerEnvironment(await resolve(alchemy(flags), command));
    expect(actual).toEqual(expected);
  });

  it.each(["serve", "build"] as const)("%s: the client environment", async (command) => {
    const expected = clientEnvironment(await resolve(official(flags), command));
    const actual = clientEnvironment(await resolve(alchemy(flags), command));
    expect(actual).toEqual(expected);
  });

  it.each(["serve", "build"] as const)("%s: app type and denied files", async (command) => {
    const expected = await resolve(official(flags), command);
    const actual = await resolve(alchemy(flags), command);
    expect(actual.appType).toBe(expected.appType);
    // Alchemy also denies its own state and stack files.
    expect(actual.server.fs.deny).toEqual(expect.arrayContaining(expected.server.fs.deny));
  });
});

describe("ALCHEMY_DIR", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("denies the moved runtime directory", async () => {
    vi.stubEnv("ALCHEMY_DIR", NodePath.join(root, ".alchemy-ci"));
    const actual = await resolve(alchemy([]), "serve");
    // Vite matches posix paths, Windows included.
    const posixRoot = root.replaceAll("\\", "/");
    expect(actual.server.fs.deny).toContain(`${posixRoot}/.alchemy-ci/**`);
    // Vite's own matcher, as the dev server checks each request.
    const denied = (actual as unknown as { fsDenyGlob: (file: string) => boolean }).fsDenyGlob;
    expect(denied(`${posixRoot}/.alchemy-ci/state/test/stage/Api.json`)).toBe(true);
    expect(denied(`${posixRoot}/.alchemy-ci-sibling/file.txt`)).toBe(false);
  });

  it("adds nothing when unset", async () => {
    vi.stubEnv("ALCHEMY_DIR", "");
    const actual = await resolve(alchemy([]), "serve");
    const posixRoot = root.replaceAll("\\", "/");
    expect(actual.server.fs.deny.filter((pattern) => pattern.startsWith(posixRoot))).toEqual([]);
  });
});

describe.each([
  { name: "source maps turned off", userConfig: { build: { sourcemap: false } } },
  {
    name: "the Worker's own source map setting",
    userConfig: { environments: { ssr: { build: { sourcemap: "hidden" as const } } } },
  },
  { name: "a CSS target", userConfig: { build: { cssTarget: ["chrome100", "safari15"] } } },
  {
    name: "the Worker's own CSS target",
    userConfig: { environments: { ssr: { build: { cssTarget: "chrome100" } } } },
  },
])("resolved config matches @cloudflare/vite-plugin with $name", ({ userConfig }) => {
  it.each(["serve", "build"] as const)("%s", async (command) => {
    const expected = await resolve(official(["nodejs_compat"]), command, userConfig);
    const actual = await resolve(alchemy(["nodejs_compat"]), command, userConfig);
    expect(workerEnvironment(actual)).toEqual(workerEnvironment(expected));
    expect(clientEnvironment(actual)).toEqual(clientEnvironment(expected));
  });
});

describe("keeps Vite's output directories", () => {
  it.each([
    {
      outDir: undefined,
      ssr: NodePath.join("dist", "ssr"),
      client: NodePath.join("dist", "client"),
    },
    { outDir: "out", ssr: NodePath.join("out", "ssr"), client: NodePath.join("out", "client") },
  ])("with build.outDir $outDir", async ({ outDir, ssr, client }) => {
    const config = await resolve(
      alchemy(["nodejs_compat"]),
      "build",
      outDir === undefined ? {} : { build: { outDir } },
    );
    expect(config.environments.ssr!.build.outDir).toBe(ssr);
    expect(config.environments.client!.build.outDir).toBe(client);
  });
});

describe("resolved config matches @cloudflare/vite-plugin in production", () => {
  it("defines the production NODE_ENV", async () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const expected = workerEnvironment(await resolve(official(["nodejs_compat"]), "build"));
      const actual = workerEnvironment(await resolve(alchemy(["nodejs_compat"]), "build"));
      expect(actual.define).toEqual(expected.define);
      expect(actual.optimizeDeps.define).toEqual(expected.optimizeDeps.define);
    } finally {
      process.env.NODE_ENV = previous;
    }
  });
});
