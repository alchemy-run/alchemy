import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import { toOutputFile, type BuildOutput } from "../index.ts";
import {
  NODE_BUNDLE_CONDITIONS,
  NODE_SERVE_ENTRY_FILE_NAME,
  makeNodeServeEntrySource,
  pinNodeServeModule,
  relativeClientDirExpression,
} from "../NodeServe.ts";

describe("NODE_BUNDLE_CONDITIONS", () => {
  it("is node-first and excludes workerd / aws-sdk", () => {
    expect(NODE_BUNDLE_CONDITIONS).toEqual(["node", "import", "module", "default"]);
    expect(NODE_BUNDLE_CONDITIONS).not.toContain("workerd");
  });
});

describe("relativeClientDirExpression", () => {
  it("emits an import.meta.url-relative file URL", () => {
    expect(
      relativeClientDirExpression("/project/dist/server/serve-node.mjs", "/project/dist/client"),
    ).toBe(`fileURLToPath(new URL("../client/", import.meta.url))`);
  });
});

describe("makeNodeServeEntrySource", () => {
  it("listens on PORT, answers /health, serves static files, then the fetch handler", () => {
    const source = makeNodeServeEntrySource({
      clientDirExpression: `fileURLToPath(new URL("../client/", import.meta.url))`,
      handler: {
        kind: "fetch",
        imports: `import { handler } from "./index.mjs";`,
        expr: "handler",
      },
    });
    expect(source).toContain("/health");
    expect(source).toContain("process.env.PORT");
    expect(source).toContain("http.createServer(async (req, res) => {");
    expect(source).toContain("server.listen");
    expect(source).toContain("lookupStatic");
    expect(source).toContain('"cache-control": "no-cache"');
    expect(source).not.toContain("max-age=31536000");
    expect(source).toContain(`import { handler } from "./index.mjs";`);
    expect(source).not.toContain("aws-lambda");
    expect(source).not.toContain("cloudflare:");
    expect(source).not.toContain("streamifyResponse");
  });

  it("falls back to index.html for SPA not-found handling", () => {
    const source = makeNodeServeEntrySource({
      clientDirExpression: `" /assets "`,
      handler: {
        kind: "fetch",
        imports: "",
        expr: "handler",
      },
      notFoundHandling: "spa",
    });
    expect(source).toContain('lookupStatic("/index.html")');
  });

  it("serves 404.html with status 404", () => {
    const source = makeNodeServeEntrySource({
      clientDirExpression: `" /assets "`,
      handler: {
        kind: "fetch",
        imports: "",
        expr: "handler",
      },
      notFoundHandling: "404-page",
    });
    expect(source).toContain('lookupStatic("/404.html")');
    expect(source).toContain("sendFile(res, notFound, 404)");
  });

  it("looks up about.html for drop-trailing-slash", () => {
    const source = makeNodeServeEntrySource({
      clientDirExpression: `" /assets "`,
      handler: {
        kind: "fetch",
        imports: "",
        expr: "handler",
      },
      htmlHandling: "drop-trailing-slash",
    });
    expect(source).toContain('base + ".html"');
  });

  it("awaits a Node (req, res) listener from an async createServer callback", () => {
    const source = makeNodeServeEntrySource({
      clientDirExpression: `" /assets "`,
      handler: {
        kind: "node",
        imports: `import { handler } from "./index.mjs";`,
        expr: "handler",
      },
    });
    expect(source).toContain("http.createServer(async (req, res) => {");
    expect(source).toContain("endedGet(req)");
    expect(source).toContain('delete headers["content-length"]');
    expect(source).toContain("new http.IncomingMessage(req.socket)");
    expect(source).toContain("fake.push(null)");
    expect(source).not.toContain("void (async () => {");
    expect(source).not.toContain("fetchFromNode");
    expect(source).not.toContain("PassThrough");
  });

  it("omits a handler for assets-only sites and 404s after static lookup", () => {
    const source = makeNodeServeEntrySource({
      clientDirExpression: `fileURLToPath(new URL("./", import.meta.url))`,
      notFoundHandling: "spa",
    });
    expect(source).toContain("/health");
    expect(source).toContain("lookupStatic");
    expect(source).toContain('lookupStatic("/index.html")');
    expect(source).toContain('res.end("Not Found")');
    expect(source).not.toContain("toRequest");
    expect(source).not.toContain("endedGet");
    expect(source).not.toContain('from "node:stream"');
    expect(source).toContain("const isRoot = false");
  });

  it("does not map GET / onto public/index.html (SSR home stays on the handler)", () => {
    const source = makeNodeServeEntrySource({
      clientDirExpression: `fileURLToPath(new URL("../client/", import.meta.url))`,
      handler: {
        kind: "node",
        imports: `import { handler } from "./index.mjs";`,
        expr: "handler",
      },
    });
    expect(source).toContain('const isRoot = (urlPath === "/" || urlPath === "")');
    expect(source).toContain("existingFile(base, !isRoot)");
  });
});

describe("pinNodeServeModule", () => {
  it("places the serve entry first", async () => {
    const serve = await Effect.runPromise(
      toOutputFile(`server/${NODE_SERVE_ENTRY_FILE_NAME}`, "serve"),
    );
    const other = await Effect.runPromise(toOutputFile("server/index.mjs", "index"));
    const output: BuildOutput = {
      clientDirectory: "/dist/client",
      serverModules: [other],
      externalWorkspaces: new Set(),
    };
    const pinned = pinNodeServeModule(output, serve);
    expect(pinned.serverModules?.map((module_) => module_.name)).toEqual([
      `server/${NODE_SERVE_ENTRY_FILE_NAME}`,
      "server/index.mjs",
    ]);
  });
});

describe("makeNodeServeEntrySource behind a CDN", () => {
  const client = `fileURLToPath(new URL("../client/", import.meta.url))`;

  it("leaves the entry unchanged when not behind a CDN", () => {
    const source = makeNodeServeEntrySource({ clientDirExpression: client });
    expect(source).not.toContain("isHashedAsset");
    expect(source).not.toContain("x-forwarded-host");
    expect(source).not.toContain("ALCHEMY_SITE_HOST");
  });

  it("is valid JavaScript with the hash rule and the request rewrites", () => {
    const source = makeNodeServeEntrySource({
      clientDirExpression: JSON.stringify("/srv/client"),
      behindCdn: { forwardedHostSuffix: ".cdn.onstackit.cloud" },
    });
    expect(source).toContain("public,max-age=31536000,immutable");
    expect(source).toContain('".cdn.onstackit.cloud"');
    expect(source).toContain('req.headers["x-forwarded-proto"] ??= "https"');
    // Only compiled, never called: the generated source must parse.
    expect(() => new Function(source.replaceAll(/^import .*$/gm, ""))).not.toThrow();
  });

  it("marks only hash-shaped names in build-asset directories immutable", () => {
    const source = makeNodeServeEntrySource({
      clientDirExpression: client,
      behindCdn: {},
    });
    const rule = /const isHashedAsset = [\s\S]*?\n};\n/.exec(source)![0];
    const isHashedAsset = new Function(`${rule}\nreturn isHashedAsset;`)() as (
      file: string,
    ) => boolean;
    for (const hashed of [
      "assets/index-DiwrgTda.js",
      "assets/entry.a1b2c3d4.css",
      "_astro/client.BxY12_-a.js",
      "assets/index-B_xY-12a.js",
      "_nuxt/BxY12_-a.js",
      "_build/assets/index-Abcd1234.js",
      "_app/immutable/chunks/x.js",
      "_next/static/chunks/main.js",
    ]) {
      expect(isHashedAsset(hashed)).toBe(true);
    }
    for (const plain of [
      "index.html",
      "sw.js",
      "manifest.webmanifest",
      "apple-touch-icon-180x180.png",
      "assets/logo.png",
      "assets/my-component.js",
      "_app/version.json",
      "_nuxt/builds/latest.json",
      "assets/TeamPhoto.png",
      "assets/site-main-2.css",
      "assets/hero-image-12.png",
      "assets/photo-20240115.jpg",
      "public/assets/Homepage.css",
      "assets/hero-Homepage.png",
    ]) {
      expect(isHashedAsset(plain)).toBe(false);
    }
  });
});
