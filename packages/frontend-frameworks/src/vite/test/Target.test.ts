import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { isDeployTarget, resolveDeployTarget } from "../../core/index.ts";
import type { BuildOutput } from "../../core/index.ts";
import { makeAwsTarget, target } from "../aws.ts";
import type { ViteTargetConfig } from "../index.ts";

const emptyBuild: BuildOutput = {
  clientDirectory: undefined,
  serverModules: undefined,
  externalWorkspaces: new Set(),
};

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

describe("makeAwsTarget", () => {
  it("is a DeployTarget for the aws platform carrying its config", () => {
    const config: ViteTargetConfig = {
      viteEnvironments: { entry: "rsc", children: ["ssr"] },
    };
    const aws = makeAwsTarget(config);
    expect(isDeployTarget(aws)).toBe(true);
    expect(aws.platform).toBe("aws");
    expect(aws.config).toBe(config);
  });

  it("declares Node bundle conditions and @aws-sdk/ externals", () => {
    const aws = makeAwsTarget();
    expect(aws.bundle?.conditions).toEqual(["node", "import", "module"]);
    expect(aws.bundle?.external).toEqual(["@aws-sdk/"]);
  });

  it("defines a wholesale build (the child-process takeover)", () => {
    const aws = makeAwsTarget();
    expect(typeof aws.build).toBe("function");
  });

  it("passes assets-only builds through the finish pass untouched", async () => {
    const root = makeTmpDir();
    const aws = makeAwsTarget();
    const clientDirectory = NodePath.join(root, "dist", "client");
    const output = await Effect.runPromise(
      aws.finish!(
        { ...emptyBuild, clientDirectory },
        { root, framework: "vite" },
      ).pipe(Effect.provide(NodeServices.layer)) as Effect.Effect<
        BuildOutput,
        unknown
      >,
    );
    expect(output.clientDirectory).toBe(clientDirectory);
    expect(output.serverModules).toBeUndefined();
    expect(output.distDirectory).toBe(NodePath.resolve(root, "dist"));
  });
});

describe("resolveDeployTarget interop", () => {
  it("applies the factory form to the framework-assembled config", async () => {
    const config: ViteTargetConfig = {
      effect: { main: "/abs/site.ts", routes: ["/api/*"] },
    };
    const resolved = await Effect.runPromise(
      resolveDeployTarget("/tmp/project", makeAwsTarget, config),
    );
    expect(resolved.platform).toBe("aws");
    expect(resolved.config).toBe(config);
  });

  it("exports the deploy-target module contract (default + named target)", async () => {
    const module_ = await import("../aws.ts");
    expect(module_.default).toBe(module_.target);
    expect(typeof target).toBe("function");
    const value = target({});
    expect(isDeployTarget(value)).toBe(true);
  });
});
