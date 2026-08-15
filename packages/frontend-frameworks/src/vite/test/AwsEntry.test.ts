import { describe, expect, it } from "vitest";
import { generateLambdaEntry } from "../aws.ts";

describe("generateLambdaEntry", () => {
  it("wraps the framework's fetch-shaped export in ONE toLambdaHandler", () => {
    const entry = generateLambdaEntry({
      serverImport: "./server.js",
      streaming: true,
    });
    expect(entry).toContain(`import * as __alchemy_server from "./server.js";`);
    expect(entry).toContain(
      `import { toLambdaHandler } from "@alchemy.run/frontend-frameworks/aws-lambda";`,
    );
    expect(entry).toContain(
      "export const handler = toLambdaHandler(__alchemy_fetch);",
    );
    expect(entry.match(/toLambdaHandler\(/g)).toHaveLength(1);
    // Plain arm carries no alchemy imports.
    expect(entry).not.toContain("makeWebsiteHandlers");
    expect(entry).not.toContain("alchemy/AWS");
  });

  it("normalizes default { fetch } objects, bare functions, and named fetch", () => {
    const entry = generateLambdaEntry({
      serverImport: "./server.js",
      streaming: true,
    });
    // TanStack Start's createServerEntry: default export is { fetch }.
    expect(entry).toContain("__alchemy_entry.fetch.bind(__alchemy_entry)");
    // Bare handler function default export.
    expect(entry).toContain("typeof __alchemy_entry === 'function'");
    // Named `fetch` export fallback.
    expect(entry).toContain("__alchemy_server.fetch");
    // A shape with no handler is a loud module-eval failure.
    expect(entry).toContain("has no fetch handler");
  });

  it("buffered wrap for invokeMode: BUFFERED", () => {
    const entry = generateLambdaEntry({
      serverImport: "./server.js",
      streaming: false,
    });
    expect(entry).toContain(
      "export const handler = toBufferedLambdaHandler(__alchemy_fetch);",
    );
    expect(entry).not.toContain("toLambdaHandler(");
  });

  it("composes site.match ?? frameworkFetch inside the ONE streamify wrap", () => {
    const entry = generateLambdaEntry({
      serverImport: "./server.js",
      streaming: true,
      effect: {
        main: "/abs/project/src/site.ts",
        routes: ["/api/*"],
      },
    });
    expect(entry).toContain(
      `import { makeWebsiteHandlers } from 'alchemy/AWS/Lambda/WebsiteHandlers';`,
    );
    expect(entry).toContain(
      `import __alchemy_site from "/abs/project/src/site.ts";`,
    );
    expect(entry).toContain(`routes: ["/api/*"]`);
    // Exactly ONE streamify wrap, composed at the fetch layer.
    expect(entry.match(/toLambdaHandler\(/g)).toHaveLength(1);
    expect(entry).toContain(
      "export const handler = toLambdaHandler(async (request) =>",
    );
    expect(entry).toContain(
      "(await __alchemy_handlers.match(request)) ?? __alchemy_fetch(request));",
    );
  });

  it("effect arm omits routes when unset; buffered wrap composes identically", () => {
    const entry = generateLambdaEntry({
      serverImport: "./s.js",
      streaming: false,
      effect: { main: "/abs/site.ts" },
    });
    expect(entry).not.toContain("routes:");
    expect(entry).toContain(
      "export const handler = toBufferedLambdaHandler(async (request) =>",
    );
  });

  it("honors the adapterModule test seam", () => {
    const entry = generateLambdaEntry({
      serverImport: "./server.js",
      streaming: true,
      adapterModule: "/abs/src/aws-lambda/index.ts",
    });
    expect(entry).toContain(
      `import { toLambdaHandler } from "/abs/src/aws-lambda/index.ts";`,
    );
    expect(entry).not.toContain("@alchemy.run/frontend-frameworks/aws-lambda");
  });
});
