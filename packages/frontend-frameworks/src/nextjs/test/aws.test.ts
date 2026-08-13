import * as Effect from "effect/Effect";
import * as NodeFsPromises from "node:fs/promises";
import * as NodePath from "node:path";
import { describe, expect, it } from "vitest";
import { makeProject, run } from "../../core/test/helpers.ts";
import {
  DEFAULT_OPEN_NEXT_CONFIG_INPUT,
  deriveServerEntryName,
  GENERATED_CONFIG_MARKER,
  make,
  mergeOpenNextConfig,
  renderOpenNextConfig,
  type NextjsAwsOptions,
} from "../aws.ts";

const packageJson = () =>
  JSON.stringify({
    name: "test-project",
    private: true,
    type: "module",
  });

/** Run `make(options).build()` and return the failure. Every temp project
 * lacks `@opennextjs/aws`, so a build that passes config synthesis fails at
 * the resolvability pre-check — the assertion that the flow got that far. */
const buildError = (root: string, options?: Partial<NextjsAwsOptions>) =>
  run(
    make({ root, ...options }).pipe(
      Effect.flatMap((service) => service.build()),
      Effect.flip,
    ),
  );

const readConfig = (root: string) =>
  NodeFsPromises.readFile(NodePath.join(root, "open-next.config.ts"), "utf8");

describe("mergeOpenNextConfig", () => {
  it("deep-merges objects with overrides winning", () => {
    expect(
      mergeOpenNextConfig(DEFAULT_OPEN_NEXT_CONFIG_INPUT, {
        default: { minify: true, override: { queue: "sqs" } },
        dangerous: { disableIncrementalCache: true },
      }),
    ).toEqual({
      default: {
        minify: true,
        override: { wrapper: "aws-lambda-streaming", queue: "sqs" },
      },
      dangerous: { disableIncrementalCache: true },
    });
  });

  it("replaces non-object values", () => {
    expect(
      mergeOpenNextConfig(DEFAULT_OPEN_NEXT_CONFIG_INPUT, {
        default: { override: { wrapper: "aws-lambda" } },
      }),
    ).toEqual({ default: { override: { wrapper: "aws-lambda" } } });
  });
});

describe("renderOpenNextConfig", () => {
  it("carries the marker and the merged config", () => {
    const rendered = renderOpenNextConfig(DEFAULT_OPEN_NEXT_CONFIG_INPUT);
    expect(rendered).toContain(GENERATED_CONFIG_MARKER);
    expect(rendered).toContain(`"wrapper": "aws-lambda-streaming"`);
    expect(rendered).toContain("export default config;");
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

describe("config synthesis", () => {
  it("synthesizes the streaming default when the project has no config", async () => {
    const root = await makeProject({ "package.json": packageJson() });
    const error = await buildError(root);
    expect(error.message).toContain("@opennextjs/aws");
    expect(await readConfig(root)).toBe(
      renderOpenNextConfig(DEFAULT_OPEN_NEXT_CONFIG_INPUT),
    );
  });

  it("merges openNext props into the synthesized config", async () => {
    const root = await makeProject({ "package.json": packageJson() });
    const error = await buildError(root, {
      openNext: { dangerous: { disableIncrementalCache: true } },
    });
    expect(error.message).toContain("@opennextjs/aws");
    const config = await readConfig(root);
    expect(config).toContain(`"disableIncrementalCache": true`);
    expect(config).toContain(`"wrapper": "aws-lambda-streaming"`);
  });

  it("regenerates an alchemy-owned config when props change", async () => {
    const root = await makeProject({ "package.json": packageJson() });
    await buildError(root);
    expect(await readConfig(root)).not.toContain("disableIncrementalCache");
    await buildError(root, {
      openNext: { dangerous: { disableIncrementalCache: true } },
    });
    expect(await readConfig(root)).toContain(`"disableIncrementalCache": true`);
  });

  it("honors a user-authored config byte-for-byte", async () => {
    const userConfig = `const config = { default: {} };\nexport default config;\n`;
    const root = await makeProject({
      "package.json": packageJson(),
      "open-next.config.ts": userConfig,
    });
    const error = await buildError(root, {
      openNext: { dangerous: { disableIncrementalCache: true } },
    });
    expect(error.message).toContain("@opennextjs/aws");
    expect(await readConfig(root)).toBe(userConfig);
  });
});
