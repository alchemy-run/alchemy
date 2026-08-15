import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  EFFECT_MODULE_NAME,
  EFFECT_WRAPPER_NAME,
  generateDerivedOpenNextConfig,
  generateEffectEntrySource,
  generateOpenNextWrapperSource,
  OPENNEXT_TESTED_RANGE,
  openNextEffectSupportIssue,
  scanForExplicitNextServeMount,
} from "../aws.ts";

const tempDirs: Array<string> = [];
const makeTempDir = (): string => {
  const dir = NodeFs.mkdtempSync(
    NodePath.join(NodeOs.tmpdir(), "alchemy-nextjs-aws-effect-test-"),
  );
  tempDirs.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of tempDirs) {
    NodeFs.rmSync(dir, { recursive: true, force: true });
  }
});

const importModule = async (dir: string, name: string, source: string) => {
  const file = NodePath.join(dir, name);
  NodeFs.writeFileSync(file, source);
  return import(pathToFileURL(file).href);
};

describe("generateOpenNextWrapperSource", () => {
  const source = generateOpenNextWrapperSource({
    routes: ["/api/*", "!/api/hello"],
  });

  it("bakes the routes claim (exclusions included)", () => {
    expect(source).toContain(
      `const ROUTES = ${JSON.stringify(["/api/*", "!/api/hello"])};`,
    );
  });

  it("delegates the streamify wrap to the stock streaming wrapper", () => {
    expect(source).toContain(
      '"@opennextjs/aws/overrides/wrappers/aws-lambda-streaming.js"',
    );
    expect(source).toContain("stock.wrapper(composed, converter)");
  });

  it("loads the prebundled effect module beside the deployed config", () => {
    expect(source).toContain(`"./${EFFECT_MODULE_NAME}"`);
  });

  it("strips content-encoding and lifts set-cookie into the prelude", () => {
    expect(source).toContain('lower === "set-cookie"');
    expect(source).toContain('lower === "content-encoding"');
    expect(source).toContain("getSetCookie");
  });

  it("is pure data at the top level: importable with no side effects", async () => {
    const dir = makeTempDir();
    const before = (globalThis as Record<string, unknown>).__ALCHEMY_RUNTIME__;
    const module_ = await importModule(dir, EFFECT_WRAPPER_NAME, source);
    // The build's canStream probe reads these off the evaluated module.
    expect(module_.default.supportStreaming).toBe(true);
    expect(module_.default.name).toBe("alchemy-effect-streaming");
    expect(typeof module_.default.wrapper).toBe("function");
    // Importing must not stamp the runtime flag (that happens inside the
    // wrapper body, cold-start only) — the build evaluates this module.
    expect((globalThis as Record<string, unknown>).__ALCHEMY_RUNTIME__).toBe(
      before,
    );
  });
});

describe("generateEffectEntrySource", () => {
  it("exports the serve shell and the site module from one graph", () => {
    const source = generateEffectEntrySource("/abs/project/app/backend.ts");
    expect(source).toContain(
      'export { makeWebsiteHandlers } from "alchemy/AWS/Lambda/WebsiteHandlers";',
    );
    expect(source).toContain(
      'export { default } from "/abs/project/app/backend.ts";',
    );
  });
});

describe("generateDerivedOpenNextConfig", () => {
  it("is self-contained without a user config", async () => {
    const source = generateDerivedOpenNextConfig({});
    expect(source).not.toContain("userConfig");
    expect(source).toContain(`import("./${EFFECT_WRAPPER_NAME}")`);
    // Importable, and the wrapper thunk stays lazy (the wrapper file does
    // not exist in the temp dir — a non-lazy reference would throw).
    const dir = makeTempDir();
    const module_ = await importModule(dir, "config.mjs", source);
    expect(typeof module_.default.default.override.wrapper).toBe("function");
  });

  it("spreads a user config through, re-pointing only the wrapper", async () => {
    const dir = makeTempDir();
    const userPath = NodePath.join(dir, "user.config.mjs");
    NodeFs.writeFileSync(
      userPath,
      `export default {
        buildCommand: "npx next build --webpack",
        dangerous: { disableTagCache: true },
        default: {
          minify: true,
          override: { wrapper: "aws-lambda-streaming", converter: "aws-apigw-v2" },
        },
      };`,
    );
    const module_ = await importModule(
      dir,
      "derived.config.mjs",
      generateDerivedOpenNextConfig({ userConfigPath: userPath }),
    );
    const merged = module_.default;
    expect(merged.buildCommand).toBe("npx next build --webpack");
    expect(merged.dangerous).toEqual({ disableTagCache: true });
    expect(merged.default.minify).toBe(true);
    // Only the wrapper is re-pointed; sibling overrides pass through.
    expect(merged.default.override.converter).toBe("aws-apigw-v2");
    expect(typeof merged.default.override.wrapper).toBe("function");
  });

  const refusal = async (userSource: string): Promise<string> => {
    const dir = makeTempDir();
    const userPath = NodePath.join(dir, "user.config.mjs");
    NodeFs.writeFileSync(userPath, userSource);
    try {
      await importModule(
        dir,
        "derived.config.mjs",
        generateDerivedOpenNextConfig({ userConfigPath: userPath }),
      );
    } catch (error) {
      return String(error);
    }
    throw new Error("expected the derived config to refuse");
  };

  it("refuses a non-streaming wrapper with the takeover fallback", async () => {
    const message = await refusal(
      `export default { default: { override: { wrapper: "aws-lambda" } } };`,
    );
    expect(message).toContain('"aws-lambda"');
    expect(message).toContain("takeover: false");
    expect(message).toContain("alchemy/Next");
  });

  it("refuses a custom (function-form) wrapper", async () => {
    const message = await refusal(
      `export default { default: { override: { wrapper: () => import("./my-wrapper.mjs") } } };`,
    );
    expect(message).toContain("a custom override");
    expect(message).toContain("takeover: false");
  });

  it("refuses the edge runtime on the default function", async () => {
    const message = await refusal(
      `export default { default: { runtime: "edge" } };`,
    );
    expect(message).toContain('"edge"');
    expect(message).toContain("takeover: false");
  });

  it("refuses edge-runtime split functions", async () => {
    const message = await refusal(
      `export default { default: {}, functions: { api: { runtime: "edge", routes: ["app/api/route"], patterns: ["api/*"] } } };`,
    );
    expect(message).toContain("edge-runtime split function");
  });

  it("refuses an external middleware origin", async () => {
    const message = await refusal(
      `export default { default: {}, middleware: { external: true } };`,
    );
    expect(message).toContain("middleware.external");
  });
});

describe("scanForExplicitNextServeMount", () => {
  it("detects a toRouteHandler mount in app/", () => {
    const root = makeTempDir();
    const routeDir = NodePath.join(root, "app", "api", "[[...slug]]");
    NodeFs.mkdirSync(routeDir, { recursive: true });
    NodeFs.writeFileSync(
      NodePath.join(routeDir, "route.ts"),
      'import { toRouteHandler } from "alchemy/Next";\n' +
        'import Site from "../../backend.ts";\n' +
        "const handler = toRouteHandler(Site);\n" +
        "export { handler as GET, handler as POST };\n",
    );
    expect(scanForExplicitNextServeMount(root)).toBe(true);
  });

  it("detects a mount under src/app/", () => {
    const root = makeTempDir();
    const routeDir = NodePath.join(root, "src", "app", "api", "[[...slug]]");
    NodeFs.mkdirSync(routeDir, { recursive: true });
    NodeFs.writeFileSync(
      NodePath.join(routeDir, "route.ts"),
      'import { toRouteHandler } from "alchemy/Next";\n',
    );
    expect(scanForExplicitNextServeMount(root)).toBe(true);
  });

  it("does not false-positive on the createClient graph", () => {
    const root = makeTempDir();
    const appDir = NodePath.join(root, "app");
    NodeFs.mkdirSync(appDir, { recursive: true });
    NodeFs.writeFileSync(
      NodePath.join(appDir, "page.tsx"),
      // The value-form createClient graph (alchemy/Client) must NOT
      // false-positive the stand-down.
      'import { createClient } from "alchemy/Client";\n' +
        'import Backend from "./backend.ts";\n' +
        "export default () => createClient(Backend);\n",
    );
    // The backend module itself (capability imports) is not a mount either.
    NodeFs.writeFileSync(
      NodePath.join(appDir, "backend.ts"),
      'import { Bucket } from "alchemy/AWS/S3";\n' +
        'import { Nextjs } from "alchemy/AWS/Website";\n',
    );
    expect(scanForExplicitNextServeMount(root)).toBe(false);
  });

  it("is false for a project with no route trees", () => {
    expect(scanForExplicitNextServeMount(makeTempDir())).toBe(false);
  });
});

describe("openNextEffectSupportIssue", () => {
  /** Lay out a fake installed @opennextjs/aws and return its CLI path. */
  const fakeInstall = (options: {
    version: string;
    stockWrapper: boolean;
  }): string => {
    const packageDir = NodePath.join(makeTempDir(), "@opennextjs", "aws");
    const distDir = NodePath.join(packageDir, "dist");
    NodeFs.mkdirSync(distDir, { recursive: true });
    NodeFs.writeFileSync(
      NodePath.join(packageDir, "package.json"),
      JSON.stringify({ name: "@opennextjs/aws", version: options.version }),
    );
    NodeFs.writeFileSync(NodePath.join(distDir, "index.js"), "// cli\n");
    if (options.stockWrapper) {
      const wrapperDir = NodePath.join(distDir, "overrides", "wrappers");
      NodeFs.mkdirSync(wrapperDir, { recursive: true });
      NodeFs.writeFileSync(
        NodePath.join(wrapperDir, "aws-lambda-streaming.js"),
        "export default {};\n",
      );
    }
    return NodePath.join(distDir, "index.js");
  };

  it("accepts the tested 4.x layout", () => {
    expect(
      openNextEffectSupportIssue(
        fakeInstall({ version: "4.1.0", stockWrapper: true }),
      ),
    ).toBeUndefined();
  });

  it("names the tested range and the fallback on an untested major", () => {
    const issue = openNextEffectSupportIssue(
      fakeInstall({ version: "5.0.0", stockWrapper: true }),
    );
    expect(issue).toContain(OPENNEXT_TESTED_RANGE);
    expect(issue).toContain("5.0.0");
    expect(issue).toContain("takeover: false");
  });

  it("trips on a drifted stock-wrapper layout", () => {
    const issue = openNextEffectSupportIssue(
      fakeInstall({ version: "4.9.9", stockWrapper: false }),
    );
    expect(issue).toContain("aws-lambda-streaming.js");
    expect(issue).toContain(OPENNEXT_TESTED_RANGE);
  });
});
