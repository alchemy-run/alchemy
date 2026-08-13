import * as Effect from "effect/Effect";
import * as NodeFsPromises from "node:fs/promises";
import * as NodePath from "node:path";
import { describe, expect, it } from "vitest";
import { makeProject, run } from "../../core/test/helpers.ts";
import {
  DEFAULT_BUILD_COMMAND,
  DEFAULT_OPEN_NEXT_CONFIG,
  deriveServerEntryName,
  make,
  makeDefaultOpenNextConfig,
  makeOverrideOpenNextConfig,
  missingBuildScriptMessage,
  OVERRIDE_OPEN_NEXT_CONFIG_PATH,
} from "../aws.ts";

const packageJson = (scripts?: Record<string, string>) =>
  JSON.stringify({
    name: "test-project",
    private: true,
    type: "module",
    ...(scripts === undefined ? {} : { scripts }),
  });

/** Run `make(options).build()` and return the failure. */
const buildError = (root: string, options?: { build?: { command?: string } }) =>
  run(
    make({ root, ...options }).pipe(
      Effect.flatMap((service) => service.build()),
      Effect.flip,
    ),
  );

describe("makeDefaultOpenNextConfig", () => {
  it("omits buildCommand by default", () => {
    const config = makeDefaultOpenNextConfig();
    expect(config).not.toContain("buildCommand");
    expect(config).toContain(`wrapper: "aws-lambda-streaming"`);
    expect(DEFAULT_OPEN_NEXT_CONFIG).toBe(config);
  });

  it("writes the buildCommand when given", () => {
    const config = makeDefaultOpenNextConfig({
      buildCommand: DEFAULT_BUILD_COMMAND,
    });
    expect(config).toContain(`buildCommand: "npx next build",`);
    expect(config).toContain(`wrapper: "aws-lambda-streaming"`);
  });
});

describe("deriveServerEntryName", () => {
  it("applies defaults", () => {
    expect(deriveServerEntryName({})).toBe(
      "server-functions/default/index.mjs",
    );
  });

  it("derives from bundle and handler", () => {
    expect(
      deriveServerEntryName({
        bundle: ".open-next/server-functions/api/",
        handler: "server.handler",
      }),
    ).toBe("server-functions/api/server.mjs");
  });
});

describe("build pre-flight", () => {
  it("fails actionably when package.json has no build script and the user's config sets no buildCommand", async () => {
    const root = await makeProject({
      "package.json": packageJson({ dev: "next dev" }),
      "open-next.config.ts": `const config = {};\nexport default config;\n`,
    });
    const error = await buildError(root);
    expect(error.message).toBe(
      missingBuildScriptMessage("open-next.config.ts"),
    );
    expect(error.message).toContain(`build: { command: "npx next build" }`);
  });

  it("proceeds when the user's config sets buildCommand", async () => {
    const root = await makeProject({
      "package.json": packageJson(),
      "open-next.config.ts": `const config = { buildCommand: "npx next build" };\nexport default config;\n`,
    });
    // The pre-flight passes; the build then fails resolving the (absent)
    // @opennextjs/aws dependency instead.
    const error = await buildError(root);
    expect(error.message).toContain("@opennextjs/aws");
  });

  it("generates a config with buildCommand when package.json has no build script", async () => {
    const root = await makeProject({ "package.json": packageJson() });
    const error = await buildError(root);
    expect(error.message).toContain("@opennextjs/aws");
    const config = await NodeFsPromises.readFile(
      NodePath.join(root, "open-next.config.ts"),
      "utf8",
    );
    expect(config).toBe(
      makeDefaultOpenNextConfig({ buildCommand: DEFAULT_BUILD_COMMAND }),
    );
  });

  it("generates a config without buildCommand when package.json has a build script", async () => {
    const root = await makeProject({
      "package.json": packageJson({ build: "next build" }),
    });
    const error = await buildError(root);
    expect(error.message).toContain("@opennextjs/aws");
    const config = await NodeFsPromises.readFile(
      NodePath.join(root, "open-next.config.ts"),
      "utf8",
    );
    expect(config).toBe(DEFAULT_OPEN_NEXT_CONFIG);
  });
});

describe("build.command", () => {
  it("applies an explicit command through the override config", async () => {
    const root = await makeProject({
      "package.json": packageJson({ build: "next build" }),
      "open-next.config.ts": `const config = {};\nexport default config;\n`,
    });
    const error = await buildError(root, {
      build: { command: "npx next build --turbopack" },
    });
    // The pre-flight passes; the build then fails resolving the (absent)
    // @opennextjs/aws dependency instead.
    expect(error.message).toContain("@opennextjs/aws");
    const override = await NodeFsPromises.readFile(
      NodePath.join(root, OVERRIDE_OPEN_NEXT_CONFIG_PATH),
      "utf8",
    );
    expect(override).toBe(
      makeOverrideOpenNextConfig({
        configPath: "open-next.config.ts",
        buildCommand: "npx next build --turbopack",
      }),
    );
    expect(override).toContain(`import config from "./open-next.config.ts"`);
    expect(override).toContain(`buildCommand: "npx next build --turbopack"`);
  });

  it("beats the missing-build-script pre-flight", async () => {
    const root = await makeProject({
      "package.json": packageJson(),
      "open-next.config.ts": `const config = {};\nexport default config;\n`,
    });
    const error = await buildError(root, {
      build: { command: "npx next build" },
    });
    expect(error.message).toContain("@opennextjs/aws");
  });

  it("generates the default config without buildCommand and overrides via the wrapper", async () => {
    const root = await makeProject({ "package.json": packageJson() });
    const error = await buildError(root, {
      build: { command: "bun x next build" },
    });
    expect(error.message).toContain("@opennextjs/aws");
    const config = await NodeFsPromises.readFile(
      NodePath.join(root, "open-next.config.ts"),
      "utf8",
    );
    expect(config).toBe(DEFAULT_OPEN_NEXT_CONFIG);
    const override = await NodeFsPromises.readFile(
      NodePath.join(root, OVERRIDE_OPEN_NEXT_CONFIG_PATH),
      "utf8",
    );
    expect(override).toContain(`buildCommand: "bun x next build"`);
  });
});
