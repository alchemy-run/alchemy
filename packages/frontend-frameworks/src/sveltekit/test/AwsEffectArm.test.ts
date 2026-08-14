import { describe, expect, it } from "vitest";
import { generateLambdaEntry } from "../aws.ts";
import { makeEffectDevPlugin } from "../EffectDev.ts";

describe("generateLambdaEntry effect arm (AWS)", () => {
  it("keeps the plain arm byte-compatible (kit's respond is the handler)", () => {
    const plain = generateLambdaEntry({
      serverImport: "./../output/server/index.js",
      manifestImport: "./manifest.js",
      streaming: true,
    });
    expect(plain).toContain("export const handler = toLambdaHandler(respond);");
    expect(plain).not.toContain("makeWebsiteHandlers");
    expect(plain).not.toContain("alchemy/AWS");
  });

  it("composes site.match ?? respond inside the ONE toLambdaHandler wrap", () => {
    const entry = generateLambdaEntry({
      serverImport: "./../output/server/index.js",
      manifestImport: "./manifest.js",
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
      "(await __alchemy_handlers.match(request)) ?? respond(request));",
    );
  });

  it("middleware mode omits routes; buffered wrap composes identically", () => {
    const entry = generateLambdaEntry({
      serverImport: "./s.js",
      manifestImport: "./m.js",
      streaming: false,
      effect: { main: "/abs/site.ts" },
    });
    expect(entry).not.toContain("routes:");
    expect(entry).toContain(
      "export const handler = toBufferedLambdaHandler(async (request) =>",
    );
  });
});

describe("EffectDev aws arm", () => {
  const plugin = makeEffectDevPlugin({
    effect: { main: "/abs/project/src/site.ts", routes: ["/api/*"] },
    emulate: () => undefined,
    platform: "aws",
  });

  it("virtual module mounts makeWebsiteHandlers over process.env", () => {
    const load = plugin.load as (id: string) => string | undefined;
    const code = load("\0virtual:alchemy-sveltekit-effect");
    expect(code).toContain(
      `import { makeWebsiteHandlers } from "alchemy/AWS/Lambda/WebsiteHandlers";`,
    );
    expect(code).toContain(`import Site from "/abs/project/src/site.ts";`);
    // The middleware gates `server.routes` before dispatching, so the
    // handlers claim everything they receive ("/*") — a narrower claim
    // here would shadow a broader construct claim.
    expect(code).toContain(
      `export const handle = makeWebsiteHandlers({ site: Site, routes: ["/*"] });`,
    );
    expect(code).not.toContain(`"alchemy/serve"`);
  });

  it("cloudflare arm still mounts alchemy/serve", () => {
    const cf = makeEffectDevPlugin({
      effect: { main: "/abs/project/src/site.ts" },
      emulate: () => undefined,
    });
    const load = cf.load as (id: string) => string | undefined;
    const code = load("\0virtual:alchemy-sveltekit-effect");
    expect(code).toContain(`import { make } from "alchemy/serve";`);
    expect(code).not.toContain("makeWebsiteHandlers");
  });
});
