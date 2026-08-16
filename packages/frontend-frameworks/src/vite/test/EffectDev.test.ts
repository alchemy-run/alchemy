import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  makeEffectDevPlugin,
  matchServerRoutes,
  scanForExplicitServeMount,
} from "../effect.ts";

const tmpDirs: Array<string> = [];
const makeTmpDir = (): string => {
  const dir = NodeFs.mkdtempSync(
    NodePath.join(NodeOs.tmpdir(), "alchemy-vite-"),
  );
  tmpDirs.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of tmpDirs) {
    NodeFs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("matchServerRoutes", () => {
  it("matches the runWorkerFirst glob dialect (* crosses /)", () => {
    expect(matchServerRoutes(["/api/*"], "/api/users")).toBe(true);
    expect(matchServerRoutes(["/api/*"], "/api/users/42")).toBe(true);
    expect(matchServerRoutes(["/api/*"], "/about")).toBe(false);
    expect(matchServerRoutes(["/api/*"], "/api")).toBe(false);
  });

  it("exclusions win over inclusions", () => {
    const routes = ["/api/*", "!/api/public/*"];
    expect(matchServerRoutes(routes, "/api/users")).toBe(true);
    expect(matchServerRoutes(routes, "/api/public/logo.png")).toBe(false);
  });
});

describe("EffectDev plugin", () => {
  it("aws arm mounts makeWebsiteHandlers over process.env", () => {
    const plugin = makeEffectDevPlugin({
      effect: { main: "/abs/project/src/site.ts", routes: ["/api/*"] },
      platform: "aws",
    });
    const load = plugin.load as (id: string) => string | undefined;
    const code = load("\0virtual:alchemy-vite-effect");
    expect(code).toContain(
      `import { makeWebsiteHandlers } from "alchemy/AWS/Lambda/ServeBridge";`,
    );
    expect(code).toContain(`import Site from "/abs/project/src/site.ts";`);
    // The middleware gates `server.routes` before dispatching, so the
    // handlers claim everything they receive ("/*") — a narrower claim
    // here would shadow a broader construct claim.
    expect(code).toContain(
      `export const handle = makeWebsiteHandlers({ site: Site, routes: ["/*"] });`,
    );
    expect(code).not.toContain(`"alchemy/Serve"`);
  });

  it("default arm mounts alchemy/Serve", () => {
    const plugin = makeEffectDevPlugin({
      effect: { main: "/abs/project/src/site.ts" },
    });
    const load = plugin.load as (id: string) => string | undefined;
    const code = load("\0virtual:alchemy-vite-effect");
    expect(code).toContain(`import { make } from "alchemy/Serve";`);
    expect(code).not.toContain("makeWebsiteHandlers");
  });

  it("is dev-only and forces one alchemy instance (ssr.external)", () => {
    const plugin = makeEffectDevPlugin({
      effect: { main: "/abs/site.ts" },
      platform: "aws",
    });
    expect(plugin.apply).toBe("serve");
    expect(plugin.enforce).toBe("pre");
    const config = (plugin.config as () => { ssr: { external: string[] } })();
    expect(config.ssr.external).toEqual(["alchemy"]);
  });
});

describe("scanForExplicitServeMount", () => {
  it("detects an alchemy/Serve import in the built server graph", () => {
    const dir = makeTmpDir();
    NodeFs.mkdirSync(NodePath.join(dir, "chunks"), { recursive: true });
    NodeFs.writeFileSync(
      NodePath.join(dir, "chunks", "app.js"),
      `import { make } from "alchemy/Serve";\nexport const handle = make({});\n`,
    );
    expect(scanForExplicitServeMount(dir)).toBe(true);
  });

  it("stays quiet for plain framework output (and missing dirs)", () => {
    const dir = makeTmpDir();
    NodeFs.writeFileSync(
      NodePath.join(dir, "server.js"),
      `export default { fetch: () => new Response("ok") };\n`,
    );
    expect(scanForExplicitServeMount(dir)).toBe(false);
    expect(scanForExplicitServeMount(NodePath.join(dir, "missing"))).toBe(
      false,
    );
  });
});
