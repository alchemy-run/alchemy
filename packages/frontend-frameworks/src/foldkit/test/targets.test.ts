import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { makeNeonServeEntrySource } from "../../core/NeonServe.ts";
import { makeNodeServeEntrySource } from "../../core/NodeServe.ts";
import { makeAwsTarget } from "../aws.ts";
import {
  metadataReader,
  readFoldkitOutput,
  type BuildMetadata,
} from "../Foldkit.ts";
import { target as makeNeonTarget } from "../neon.ts";
import { makeNodeTarget } from "../node.ts";

const run = <A, E>(
  effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
) => Effect.runPromise(effect.pipe(Effect.provide(NodeServices.layer)));
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});
const fixture = async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "foldkit-target-"));
  roots.push(root);
  // Independent output directories and a nested entry exercise the metadata contract.
  const clientDirectory = path.join(root, "public-output");
  const serverDirectory = path.join(root, "backend-output");
  const serverEntry = path.join(serverDirectory, "nested", "fetch.js");
  await fs.mkdir(path.join(clientDirectory, "about"), { recursive: true });
  await fs.mkdir(path.dirname(serverEntry), { recursive: true });
  await fs.writeFile(
    path.join(clientDirectory, "index.html"),
    "prerendered home",
  );
  await fs.writeFile(
    path.join(clientDirectory, "about", "index.html"),
    "prerendered about",
  );
  await fs.writeFile(path.join(clientDirectory, "asset.txt"), "asset");
  await fs.writeFile(
    serverEntry,
    `export default { async fetch(request) {
    const url = new URL(request.url);
    return new Response(request.method + ":" + url.pathname + url.search + ":" + await request.text(), { status: url.pathname.endsWith(".js") ? 404 : 200 });
  } };`,
  );
  const metadata: BuildMetadata = {
    root,
    clientDirectory,
    serverDirectory,
    serverEntry,
    manifest: {
      schemaVersion: 1,
      client: "public-output",
      server: "backend-output",
      serverEntry: "nested/fetch.js",
      prerendered: ["/", "/about"],
    },
  };
  return metadata;
};

const assertRouting = async (
  fetcher: (pathname: string, init?: RequestInit) => Promise<Response>,
) => {
  expect(await (await fetcher("/")).text()).toBe("prerendered home");
  expect(await (await fetcher("/about?count=7")).text()).toBe(
    "prerendered about",
  );
  expect(await (await fetcher("/dynamic?count=7")).text()).toBe(
    "GET:/dynamic?count=7:",
  );
  expect(await (await fetcher("/asset.txt")).text()).toBe("asset");
  expect((await fetcher("/missing.js")).status).toBe(404);
  expect(
    await (await fetcher("/about", { method: "POST", body: "payload" })).text(),
  ).toBe("POST:/about:payload");
  for (const pathname of ["/", "/about", "/dynamic"]) {
    const response = await fetcher(pathname, { method: "HEAD" });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
  }
};

describe("Foldkit deployment targets", () => {
  it("packages only client/server artifacts with a portable, entry-first layout", async () => {
    const metadata = await fixture();
    await fs.writeFile(
      path.join(metadata.root, ".env"),
      "PRIVATE=not-deployed",
    );
    const { output, entry } = await run(
      readFoldkitOutput(metadata.root, metadata.clientDirectory, metadata),
    );
    expect(await fs.readdir(output.distDirectory!)).toEqual([
      "client",
      "server",
    ]);
    expect(output.serverModules?.[0]?.name).toBe("server/nested/fetch.js");
    expect(entry).toBe(
      path.join(output.distDirectory!, "server", "nested", "fetch.js"),
    );
    expect(
      await fs.readFile(
        path.join(output.clientDirectory!, "about/index.html"),
        "utf8",
      ),
    ).toBe("prerendered about");
    const spa = await run(
      readFoldkitOutput(metadata.root, metadata.clientDirectory),
    );
    expect(spa.output.serverModules).toBeUndefined();
    expect(await fs.readdir(spa.output.distDirectory!)).toEqual(["client"]);
  });

  it("rejects mismatched AWS topology and keeps static SSG assets only", async () => {
    const metadata = await fixture();
    await expect(
      run(
        readFoldkitOutput(
          metadata.root,
          metadata.clientDirectory,
          metadata,
          "spa",
        ),
      ),
    ).rejects.toThrow('Set output: "server"');
    await expect(
      run(
        readFoldkitOutput(
          metadata.root,
          metadata.clientDirectory,
          undefined,
          "server",
        ),
      ),
    ).rejects.toThrow("no server handler");
    await expect(
      run(
        readFoldkitOutput(
          metadata.root,
          metadata.clientDirectory,
          { ...metadata, manifest: { ...metadata.manifest, prerendered: [] } },
          "static",
        ),
      ),
    ).rejects.toThrow("requires prerendered pages");
    const { output } = await run(
      readFoldkitOutput(
        metadata.root,
        metadata.clientDirectory,
        metadata,
        "static",
      ),
    );
    expect(output.serverModules).toBeUndefined();
    expect(await fs.readdir(output.distDirectory!)).toEqual(["client"]);
    expect(
      await run(
        makeAwsTarget().finish!(output, {
          root: metadata.root,
          framework: "foldkit",
        }),
      ),
    ).toBe(output);
  });

  it("serves prerendered root/nested paths before SSR on Node, preserving methods and queries", async () => {
    const metadata = await fixture();
    const { output, entry } = await run(
      readFoldkitOutput(metadata.root, metadata.clientDirectory, metadata),
    );
    const finished = await run(
      makeNodeTarget().finish!(output, {
        root: metadata.root,
        framework: "foldkit",
        entry,
      }),
    );
    const servePath = path.join(
      finished.distDirectory!,
      finished.serverModules![0]!.name,
    );
    // Add only a readiness notification, leaving the generated request handling intact.
    await fs.appendFile(
      servePath,
      '\nserver.on("listening", () => console.log(server.address().port));\n',
    );
    const child = spawn(process.execPath, [servePath], {
      env: { ...process.env, PORT: "0", HOST: "127.0.0.1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let errors = "";
    child.stderr.on("data", (chunk) => {
      errors += String(chunk);
    });
    try {
      const port = await new Promise<number>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("Node entry readiness timed out: " + errors)),
          5000,
        );
        child.stdout.once("data", (chunk) => {
          clearTimeout(timer);
          resolve(Number(String(chunk).trim()));
        });
        child.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.once("exit", (code) => {
          clearTimeout(timer);
          reject(new Error("Node entry exited: " + code + errors));
        });
      });
      await assertRouting((pathname, init) =>
        fetch(`http://127.0.0.1:${port}${pathname}`, init),
      );
    } finally {
      if (child.exitCode === null) {
        const exited = once(child, "exit");
        child.kill();
        await exited;
      }
    }
  });

  it("preserves the same routing in Neon's Fetch module", async () => {
    const metadata = await fixture();
    const { output, entry } = await run(
      readFoldkitOutput(metadata.root, metadata.clientDirectory, metadata),
    );
    const finished = await run(
      makeNeonTarget().finish!(output, {
        root: metadata.root,
        framework: "foldkit",
        entry,
      }),
    );
    const module = await import(
      pathToFileURL(
        path.join(finished.distDirectory!, finished.serverModules![0]!.name),
      ).href
    );
    await assertRouting((pathname, init) =>
      module.default.fetch(new Request("http://example.test" + pathname, init)),
    );
  });

  it("preserves SPA fallback and explicit 404 overrides without a Foldkit handler", async () => {
    for (const notFoundHandling of [undefined, "none"] as const) {
      const metadata = await fixture();
      const { output } = await run(
        readFoldkitOutput(metadata.root, metadata.clientDirectory),
      );
      const finished = await run(
        makeNeonTarget({ notFoundHandling }).finish!(output, {
          root: metadata.root,
          framework: "foldkit",
        }),
      );
      const module = await import(
        pathToFileURL(
          path.join(finished.distDirectory!, finished.serverModules![0]!.name),
        ).href
      );
      const response = await module.default.fetch(
        new Request("http://example.test/deep/link"),
      );
      expect(response.status).toBe(notFoundHandling ? 404 : 200);
      if (!notFoundHandling)
        expect(await response.text()).toBe("prerendered home");
    }
  });

  it("adapts Foldkit's nested fetch entry to a buffered Lambda handler", async () => {
    const metadata = await fixture();
    const { output, entry } = await run(
      readFoldkitOutput(metadata.root, metadata.clientDirectory, metadata),
    );
    const finished = await run(
      makeAwsTarget({ streaming: false }).finish!(output, {
        root: metadata.root,
        framework: "foldkit",
        entry,
      }),
    );
    const module = await import(
      pathToFileURL(
        path.join(finished.distDirectory!, finished.serverModules![0]!.name),
      ).href
    );
    const response = await module.handler({
      version: "2.0",
      rawPath: "/dynamic",
      rawQueryString: "count=7",
      headers: { host: "example.test" },
      requestContext: { http: { method: "POST" } },
      body: "payload",
      isBase64Encoded: false,
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe("POST:/dynamic?count=7:payload");
  });
});

describe("Foldkit plugin metadata", () => {
  it("reads only after completion and rejects absent APIs or unknown schema versions", async () => {
    const data = await fixture();
    let complete = false;
    const read = metadataReader([
      {
        name: "foldkit:build",
        api: {
          getBuildMetadata() {
            if (!complete) throw new Error("incomplete");
            return data;
          },
        },
      },
    ]);
    expect(() => read!()).toThrow("incomplete");
    complete = true;
    expect(read!()).toEqual(data);
    expect(metadataReader([])).toBeUndefined();
    expect(() => metadataReader([{ name: "foldkit:build" }])).toThrow("0.25.0");
    expect(() =>
      metadataReader([
        {
          name: "foldkit:build",
          api: {
            getBuildMetadata: () => ({
              ...data,
              manifest: { ...data.manifest, schemaVersion: 2 },
            }),
          },
        },
      ])!(),
    ).toThrow();
  });

  it("leaves other frameworks' root-template bypass unchanged", () => {
    const options = {
      clientDirExpression: '"/client"',
      handler: { kind: "fetch" as const, imports: "", expr: "handler" },
    };
    expect(makeNodeServeEntrySource(options)).toContain(
      'const isRoot = (urlPath === "/" || urlPath === "");',
    );
    expect(makeNeonServeEntrySource(options)).toContain(
      'handle === undefined || pathname !== "/"',
    );
    expect(
      makeNodeServeEntrySource({ ...options, serveRootIndex: true }),
    ).toContain("const isRoot = false;");
    expect(
      makeNeonServeEntrySource({ ...options, serveRootIndex: true }),
    ).toContain("lookup(pathname, true)");
  });
});
