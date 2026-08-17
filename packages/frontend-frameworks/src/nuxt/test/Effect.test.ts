import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { renderEffectHandler, scanForExplicitServeMount } from "../effect.ts";

const tempDirs: Array<string> = [];
const makeTempDir = (): string => {
  const dir = NodeFs.mkdtempSync(
    NodePath.join(NodeOs.tmpdir(), "alchemy-nuxt-effect-test-"),
  );
  tempDirs.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of tempDirs) {
    NodeFs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("renderEffectHandler", () => {
  const source = renderEffectHandler({
    sitePath: "/abs/project/src/site.ts",
    routes: ["/backend/*", "!/backend/health"],
  });

  it("imports only the serve mount and the site module", () => {
    expect(source).toContain('from "alchemy/Nitro"');
    expect(source).toContain('"/abs/project/src/site.ts"');
    // No other imports: the matcher is inlined.
    expect(
      source.split("\n").filter((line) => line.startsWith("import ")),
    ).toHaveLength(2);
  });

  it("carries the routes claim (exclusions included) into the handler", () => {
    expect(source).toContain('"/backend/*"');
    expect(source).toContain('"!/backend/health"');
    expect(source).toContain("toHandler(Site, { routes })");
  });

  it("pre-gates on the routes claim alone (no reserved rpc path)", () => {
    expect(source).toContain("if (!matches(pathname))");
    expect(source).not.toContain("__rpc");
  });

  it("is an h3 v1 handler (no defineEventHandler dependency)", () => {
    expect(source).toContain("middleware.__is_handler__ = true;");
    expect(source).toContain("export default middleware;");
  });
});

describe("scanForExplicitServeMount", () => {
  const scan = (serverDir: string) =>
    Effect.runPromise(
      scanForExplicitServeMount(serverDir).pipe(
        Effect.provide(NodeServices.layer),
      ),
    );

  it("detects an alchemy/Nitro import in server/middleware", async () => {
    const root = makeTempDir();
    const middlewareDir = NodePath.join(root, "server", "middleware");
    NodeFs.mkdirSync(middlewareDir, { recursive: true });
    NodeFs.writeFileSync(
      NodePath.join(middlewareDir, "alchemy.ts"),
      'import { toHandler } from "alchemy/Nitro";\n' +
        'import Site from "../../src/site.ts";\n' +
        "export default toHandler(Site);\n",
    );
    await expect(scan(NodePath.join(root, "server"))).resolves.toBe(true);
  });

  it("ignores server files that do not mount alchemy/Serve", async () => {
    const root = makeTempDir();
    const apiDir = NodePath.join(root, "server", "api");
    NodeFs.mkdirSync(apiDir, { recursive: true });
    NodeFs.writeFileSync(
      NodePath.join(apiDir, "hello.ts"),
      // The value-form createClient graph (alchemy/Client) must NOT
      // false-positive the stand-down.
      'import { createClient } from "alchemy/Client";\n' +
        "export default () => createClient;\n",
    );
    await expect(scan(NodePath.join(root, "server"))).resolves.toBe(false);
  });

  it("is false for a missing server directory", async () => {
    const root = makeTempDir();
    await expect(scan(NodePath.join(root, "server"))).resolves.toBe(false);
  });
});
