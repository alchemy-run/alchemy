import * as NodeFs from "node:fs/promises";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";
import { cloudflare as officialCloudflare } from "@cloudflare/vite-plugin";
import * as vite from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import cloudflareVitePlugin from "../../plugin.ts";

// Differential conformance: the same project built with
// `@cloudflare/vite-plugin` and with Alchemy's plugin must produce the same
// output layout, which frameworks and deploy tooling read back.

const COMPATIBILITY_DATE = "2026-03-17";
const FLAGS = ["nodejs_compat"];

// Wrangler's deploy configuration, not part of the build output Alchemy reads.
const WRANGLER_OUTPUTS = new Set([".dev.vars", "wrangler.json", ".assetsignore"]);

const project = async () => {
  const root = await NodeFs.realpath(
    await NodeFs.mkdtemp(NodePath.join(NodeOs.tmpdir(), "alchemy-vite-build-parity-")),
  );
  const write = async (file: string, content: string) => {
    await NodeFs.mkdir(NodePath.dirname(NodePath.join(root, file)), { recursive: true });
    await NodeFs.writeFile(NodePath.join(root, file), content);
  };
  await write("package.json", JSON.stringify({ type: "module" }));
  await write(
    "src/index.ts",
    [
      `import { Buffer } from "node:buffer";`,
      `import text from "./message.txt";`,
      `export default {`,
      `  async fetch() {`,
      `    using _scope = { [Symbol.dispose]() {} };`,
      `    const { lazy } = await import("./lazy.ts");`,
      `    return new Response(Buffer.from(text + lazy).toString());`,
      `  },`,
      `};`,
    ].join("\n"),
  );
  await write("src/lazy.ts", `export const lazy = "lazy";`);
  await write("src/message.txt", "hello");
  await write(
    "src/text.d.ts",
    `declare module "*.txt" { const text: string; export default text; }`,
  );
  await write(
    "index.html",
    `<!doctype html><html><body><script type="module" src="/src/client.ts"></script></body></html>`,
  );
  await write("src/client.ts", `import "./client.css"; console.log("client");`);
  await write("src/client.css", `body { color: red; }`);
  await write("public/robots.txt", "User-agent: *");
  return root;
};

const build = async (root: string, plugins: vite.PluginOption) => {
  const builder = await vite.createBuilder({
    configFile: false,
    root,
    logLevel: "silent",
    plugins: [plugins],
  });
  await builder.buildApp();
};

/** Every output file, relative to `dist`, with content hashes normalized. */
const outputs = async (root: string) => {
  const dist = NodePath.join(root, "dist");
  const files = await NodeFs.readdir(dist, { recursive: true, withFileTypes: true });
  return files
    .filter((file) => file.isFile() && !WRANGLER_OUTPUTS.has(file.name))
    .map((file) =>
      NodePath.relative(dist, NodePath.join(file.parentPath, file.name))
        .replaceAll("\\", "/")
        .replace(/-[\w-]{8}(?=\.)/g, "-[hash]"),
    )
    .sort();
};

let officialRoot: string;
let alchemyRoot: string;

beforeAll(async () => {
  [officialRoot, alchemyRoot] = await Promise.all([project(), project()]);
  await build(
    officialRoot,
    officialCloudflare({
      viteEnvironment: { name: "ssr" },
      inspectorPort: false,
      persistState: false,
      config: {
        name: "worker",
        main: "./src/index.ts",
        compatibility_date: COMPATIBILITY_DATE,
        compatibility_flags: FLAGS,
      },
    }),
  );
  await build(
    alchemyRoot,
    cloudflareVitePlugin({
      main: "./src/index.ts",
      compatibilityDate: COMPATIBILITY_DATE,
      compatibilityFlags: FLAGS,
    }),
  );
}, 120_000);

afterAll(async () => {
  await Promise.all(
    [officialRoot, alchemyRoot].map((root) => NodeFs.rm(root, { recursive: true, force: true })),
  );
});

describe("build output matches @cloudflare/vite-plugin", () => {
  it("emits the same files", async () => {
    expect(await outputs(alchemyRoot)).toEqual(await outputs(officialRoot));
  });

  it("keeps the same entry chunk exports", async () => {
    // The exported names; the local bindings behind them are the bundler's.
    const exportedNames = (root: string) =>
      NodeFs.readFile(NodePath.join(root, "dist/ssr/index.js"), "utf8").then((code) =>
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
    expect(await exportedNames(alchemyRoot)).toEqual(await exportedNames(officialRoot));
  });

  it("keeps `using` declarations as written", async () => {
    const code = await NodeFs.readFile(NodePath.join(alchemyRoot, "dist/ssr/index.js"), "utf8");
    expect(code).toMatch(/\busing [\w$]+ =/);
  });
});
