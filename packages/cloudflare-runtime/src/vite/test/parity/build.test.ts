import * as NodeFs from "node:fs/promises";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";
import { cloudflare as officialCloudflare } from "@cloudflare/vite-plugin";
import * as vite from "vite";
import { afterAll, describe, expect, it } from "vitest";
import cloudflareVitePlugin from "../../plugin.ts";

// Differential conformance: the same project built with
// `@cloudflare/vite-plugin` and with Alchemy's plugin must produce the same
// output layout, which frameworks and deploy tooling read back.

const COMPATIBILITY_DATE = "2026-03-17";
const FLAGS = ["nodejs_compat"];

// v2 writes Build Output for `cf deploy`, which Alchemy doesn't use: each
// environment goes to its own directory under `.cloudflare/output/v1`, beside
// deploy metadata. Alchemy keeps Vite's `dist/<environment>` layout, so each
// directory is compared with the `dist` directory it replaces.
const BUILD_OUTPUT_WORKER = ".cloudflare/output/v1/workers/default";
const OFFICIAL_DIRECTORIES = { client: "assets", ssr: "bundle" } as const;

const WORKER = [
  `import { Buffer } from "node:buffer";`,
  `import text from "./message.txt";`,
  `export default {`,
  `  async fetch() {`,
  `    using _scope = { [Symbol.dispose]() {} };`,
  `    const { lazy } = await import("./lazy.ts");`,
  `    return new Response(Buffer.from(text + lazy).toString());`,
  `  },`,
  `};`,
].join("\n");

const CLIENT = {
  "index.html": `<!doctype html><html><body><script type="module" src="/src/client.ts"></script></body></html>`,
  "src/client.ts": `import "./client.css"; console.log("client");`,
  "src/client.css": `body { color: red; }`,
};

const WORKER_FILES = {
  "src/index.ts": WORKER,
  "src/lazy.ts": `export const lazy = "lazy";`,
  "src/message.txt": "hello",
};

interface Shape {
  name: string;
  files: Record<string, string>;
  /** Whether the project has a Worker entry. */
  worker: boolean;
  config?: vite.InlineConfig;
}

const ASSET_WORKER_FILES = {
  ...WORKER_FILES,
  "src/index.ts": `import logo from "./logo.svg?url";\nexport default { fetch: () => new Response(logo) };`,
  "src/logo.svg": `<svg xmlns="http://www.w3.org/2000/svg"></svg>`,
};

/** A framework's `buildApp` that builds only the Worker, as some do first. */
const buildWorkerOnly = async (builder: vite.ViteBuilder) => {
  await builder.build(builder.environments.ssr!);
};

const SHAPES: ReadonlyArray<Shape> = [
  {
    name: "a Worker and a client",
    worker: true,
    files: { ...WORKER_FILES, ...CLIENT, "public/robots.txt": "User-agent: *" },
  },
  {
    name: "a Worker and public assets only",
    worker: true,
    files: { ...WORKER_FILES, "public/robots.txt": "User-agent: *" },
  },
  { name: "a Worker importing an asset by URL", worker: true, files: ASSET_WORKER_FILES },
  {
    name: "a Worker importing an emitted asset",
    worker: true,
    files: ASSET_WORKER_FILES,
    config: { build: { assetsInlineLimit: 0 } },
  },
  {
    name: "a framework's builder.buildApp building the Worker first",
    worker: true,
    files: { ...ASSET_WORKER_FILES, ...CLIENT },
    config: { build: { assetsInlineLimit: 0 }, builder: { buildApp: buildWorkerOnly } },
  },
  {
    name: "a framework's buildApp hook building the Worker first",
    worker: true,
    files: { ...ASSET_WORKER_FILES, ...CLIENT },
    config: {
      build: { assetsInlineLimit: 0 },
      plugins: [{ name: "framework", buildApp: buildWorkerOnly }],
    },
  },
  { name: "a Worker only", worker: true, files: WORKER_FILES },
  {
    name: "assets only",
    worker: false,
    files: { ...CLIENT, "public/robots.txt": "User-agent: *" },
  },
];

const roots: Array<string> = [];

const project = async (files: Record<string, string>) => {
  const root = await NodeFs.realpath(
    await NodeFs.mkdtemp(NodePath.join(NodeOs.tmpdir(), "alchemy-vite-build-parity-")),
  );
  roots.push(root);
  for (const [file, content] of Object.entries({
    "package.json": JSON.stringify({ type: "module" }),
    ...files,
  })) {
    await NodeFs.mkdir(NodePath.dirname(NodePath.join(root, file)), { recursive: true });
    await NodeFs.writeFile(NodePath.join(root, file), content);
  }
  return root;
};

const build = async (root: string, plugins: vite.PluginOption, config: vite.InlineConfig = {}) => {
  const builder = await vite.createBuilder({
    ...config,
    configFile: false,
    root,
    logLevel: "silent",
    plugins: [plugins, ...(config.plugins ?? [])],
  });
  await builder.buildApp();
};

const official = (shape: Shape) =>
  officialCloudflare({
    inspectorPort: false,
    persistState: false,
    types: { generate: false },
    config: (loaded) => ({
      ...loaded,
      worker: {
        ...loaded.worker,
        name: "worker",
        ...(shape.worker ? { entrypoint: "./src/index.ts" } : {}),
        compatibilityDate: COMPATIBILITY_DATE,
        compatibilityFlags: FLAGS,
      },
    }),
  });

const alchemy = (shape: Shape) =>
  cloudflareVitePlugin({
    ...(shape.worker ? { main: "./src/index.ts" } : {}),
    compatibilityDate: COMPATIBILITY_DATE,
    compatibilityFlags: FLAGS,
  });

type Plugin = "official" | "alchemy";

type Environment = keyof typeof OFFICIAL_DIRECTORIES;

/**
 * Where a plugin writes an environment's output. Without a Worker, Alchemy's
 * client is Vite's only environment and builds straight to `dist`.
 */
const outDir = (root: string, plugin: Plugin, environment: Environment, worker = true) =>
  plugin === "official"
    ? NodePath.join(root, BUILD_OUTPUT_WORKER, OFFICIAL_DIRECTORIES[environment])
    : worker
      ? NodePath.join(root, "dist", environment)
      : environment === "client"
        ? NodePath.join(root, "dist")
        : undefined;

/** Every output file, as `<environment>/<path>`, with content hashes normalized. */
const outputs = async (root: string, plugin: Plugin, worker: boolean) => {
  const environments = Object.keys(OFFICIAL_DIRECTORIES) as Array<Environment>;
  const files = await Promise.all(
    environments.map(async (environment) => {
      const directory = outDir(root, plugin, environment, worker);
      if (directory === undefined) return [];
      const entries = await NodeFs.readdir(directory, {
        recursive: true,
        withFileTypes: true,
      }).catch(() => []);
      return entries
        .filter((file) => file.isFile())
        .map((file) =>
          NodePath.join(
            environment,
            NodePath.relative(directory, NodePath.join(file.parentPath, file.name)),
          )
            .replaceAll("\\", "/")
            .replace(/-[\w-]{8}(?=\.)/g, "-[hash]"),
        );
    }),
  );
  return files.flat().sort();
};

// The exported names; the local bindings behind them are the bundler's.
const exportedNames = (root: string, plugin: Plugin) =>
  NodeFs.readFile(NodePath.join(outDir(root, plugin, "ssr")!, "index.js"), "utf8").then((code) =>
    [...code.matchAll(/export\s*\{([^}]*)\}/g)]
      .flatMap((match) => match[1]!.split(","))
      .map((specifier) =>
        specifier
          .trim()
          .split(/\s+as\s+/)
          .at(-1),
      )
      .filter(Boolean)
      .sort(),
  );

afterAll(async () => {
  await Promise.all(roots.map((root) => NodeFs.rm(root, { recursive: true, force: true })));
});

describe.each(SHAPES)("build output matches @cloudflare/vite-plugin for $name", (shape) => {
  const built = (async () => {
    const [officialRoot, alchemyRoot] = await Promise.all([
      project(shape.files),
      project(shape.files),
    ]);
    await build(officialRoot, official(shape), shape.config);
    await build(alchemyRoot, alchemy(shape), shape.config);
    return { officialRoot, alchemyRoot };
  })();

  it("emits the same files", async () => {
    const { officialRoot, alchemyRoot } = await built;
    expect(await outputs(alchemyRoot, "alchemy", shape.worker)).toEqual(
      await outputs(officialRoot, "official", shape.worker),
    );
    // Only the environment directories: anything else under `dist/` would be
    // deployed without being compared above.
    if (shape.worker) {
      const stray = (await NodeFs.readdir(NodePath.join(alchemyRoot, "dist"))).filter(
        (entry) => entry !== "client" && entry !== "ssr",
      );
      expect(stray).toEqual([]);
    }
  }, 120_000);

  it.skipIf(!shape.worker)(
    "keeps the same entry chunk exports",
    async () => {
      const { officialRoot, alchemyRoot } = await built;
      expect(await exportedNames(alchemyRoot, "alchemy")).toEqual(
        await exportedNames(officialRoot, "official"),
      );
    },
    120_000,
  );
});

it("keeps `using` declarations as written", async () => {
  const root = await project(SHAPES[0]!.files);
  await build(root, alchemy(SHAPES[0]!));
  const code = await NodeFs.readFile(NodePath.join(root, "dist/ssr/index.js"), "utf8");
  expect(code).toMatch(/\busing [\w$]+ =/);
}, 120_000);
