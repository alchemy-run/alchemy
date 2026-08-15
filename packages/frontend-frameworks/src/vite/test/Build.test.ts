/**
 * End-to-end builds over real (tiny) Vite fixtures, in-process: the
 * framework half's programmatic build + collector, and the AWS target's
 * finishing pass (`buildInChild` is called directly — the documented
 * in-process form of the child contract).
 *
 * The generated Lambda entry's adapter import uses the `adapterModule`
 * test seam (an absolute path into this repo's `src/aws-lambda`) because
 * the tmp fixture has no `node_modules` to resolve the published
 * specifier from — production resolution is covered by the entry-text
 * assertions in `AwsEntry.test.ts`.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import type { BuildOutput } from "../../core/index.ts";
import { buildInChild } from "../aws.ts";
import type {
  FunctionUrlEvent,
  FunctionUrlResult,
} from "../../aws-lambda/index.ts";

const tmpDirs: Array<string> = [];
const makeTmpDir = (): string => {
  // realpath: macOS tmpdir is a /var -> /private/var symlink and vite
  // resolves the root through realpath, which would break prefix checks.
  const dir = NodeFs.realpathSync(
    NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "alchemy-vite-e2e-")),
  );
  tmpDirs.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of tmpDirs) {
    NodeFs.rmSync(dir, { recursive: true, force: true });
  }
});

const write = (root: string, name: string, content: string): void => {
  const file = NodePath.join(root, name);
  NodeFs.mkdirSync(NodePath.dirname(file), { recursive: true });
  NodeFs.writeFileSync(file, content);
};

const ADAPTER_MODULE = NodePath.resolve(
  NodePath.dirname(fileURLToPath(import.meta.url)),
  "../../aws-lambda/index.ts",
);

const writeSpaFixture = (root: string): void => {
  write(root, "package.json", `{ "name": "fixture", "type": "module" }\n`);
  write(
    root,
    "index.html",
    `<!doctype html><html><body><script type="module" src="/src/main.js"></script></body></html>\n`,
  );
  write(root, "src/main.js", `document.body.textContent = "hello";\n`);
};

const writeSsrFixture = (root: string): void => {
  writeSpaFixture(root);
  write(
    root,
    "src/server.js",
    [
      `// A minimal fetch-shaped SSR entry (the TanStack Start shape).`,
      `export default {`,
      `  fetch: (request) =>`,
      `    new Response("ssr:" + new URL(request.url).pathname, {`,
      `      headers: { "content-type": "text/plain" },`,
      `    }),`,
      `};`,
      ``,
    ].join("\n"),
  );
  write(
    root,
    "vite.config.mjs",
    [
      `export default {`,
      `  environments: {`,
      `    client: { build: { outDir: "dist/client" } },`,
      `    ssr: {`,
      `      build: {`,
      `        outDir: "dist/server",`,
      `        ssr: true,`,
      `        rollupOptions: { input: { server: "./src/server.js" } },`,
      `      },`,
      `    },`,
      `  },`,
      `  builder: {`,
      `    buildApp: async (builder) => {`,
      `      await builder.build(builder.environments.client);`,
      `      await builder.build(builder.environments.ssr);`,
      `    },`,
      `  },`,
      `};`,
      ``,
    ].join("\n"),
  );
};

const runBuild = (
  root: string,
  config: Parameters<typeof buildInChild>[0]["config"] = {},
): Promise<BuildOutput> =>
  Effect.runPromise(
    buildInChild({ rootDir: root, config }).pipe(
      Effect.provide(NodeServices.layer),
    ) as Effect.Effect<BuildOutput, unknown>,
  );

describe("vite build (in-process finish target)", () => {
  it("SPA-only project builds assets-only (no server entry)", async () => {
    const root = makeTmpDir();
    writeSpaFixture(root);
    const output = await runBuild(root);
    expect(output.serverModules).toBeUndefined();
    expect(output.clientDirectory).toBe(NodePath.join(root, "dist"));
    expect(NodeFs.existsSync(NodePath.join(root, "dist", "index.html"))).toBe(
      true,
    );
  }, 60_000);

  it("SSR project ships a self-contained dist/lambda with a working handler", async () => {
    const root = makeTmpDir();
    writeSsrFixture(root);
    const output = await runBuild(root, {
      streaming: false,
      adapterModule: ADAPTER_MODULE,
    });

    expect(output.clientDirectory).toBe(NodePath.join(root, "dist", "client"));
    expect(output.serverModules?.[0]?.name).toBe("lambda/index.mjs");
    const entryPath = NodePath.join(root, "dist", "lambda", "index.mjs");
    expect(NodeFs.existsSync(entryPath)).toBe(true);
    // The temp rolldown input is cleaned up; the framework's own server
    // outDir is left as-is next to the finished lambda directory.
    expect(
      NodeFs.readdirSync(NodePath.join(root, "dist", "server")).some((name) =>
        name.includes("__alchemy_aws_lambda_entry"),
      ),
    ).toBe(false);

    // Invoke the finished (buffered) handler like a Function URL would.
    const module_ = (await import(pathToFileURL(entryPath).href)) as {
      handler: (event: FunctionUrlEvent) => Promise<FunctionUrlResult>;
    };
    const result = await module_.handler({
      rawPath: "/greetings",
      requestContext: {
        domainName: "example.lambda-url.aws",
        http: { method: "GET" },
      },
    });
    expect(result.statusCode).toBe(200);
    expect(result.body).toBe("ssr:/greetings");
    expect(result.isBase64Encoded).toBe(false);
  }, 60_000);
});
