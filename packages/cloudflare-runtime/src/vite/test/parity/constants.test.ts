import * as NodeFs from "node:fs/promises";
import * as NodePath from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MODULE_RULES } from "../../../rolldown/plugins/additional-modules.ts";
import { CLOUDFLARE_BUILT_IN_MODULES } from "../../../rolldown/plugins/cloudflare-externals.ts";
import {
  DURABLE_OBJECT_KEYS,
  IGNORED_KEYS,
  WORKER_ENTRYPOINT_KEYS,
  WORKFLOW_ENTRYPOINT_KEYS,
} from "../../module-runner/keys.shared.ts";
import { SANDBOX_ORIGIN_REGEXP } from "../../websockets.ts";
import { AHEAD_OF_RELEASE_BUILT_IN_MODULES } from "./ahead-of-release.ts";

// The runtime pieces ported from `@cloudflare/vite-plugin`, checked against
// the installed release: a new handler key, module rule or built-in module
// upstream fails here instead of in an app.

// The package exports only its ESM entry, which lives in `dist/`.
const pluginDist = NodePath.dirname(fileURLToPath(import.meta.resolve("@cloudflare/vite-plugin")));

const read = (file: string) => NodeFs.readFile(NodePath.join(pluginDist, file), "utf8");

/** The string elements of the array literal assigned to `name`. */
const arrayLiteral = (source: string, name: string): Array<string> => {
  const match = source.match(new RegExp(`const ${name} = \\[([^\\]]*)\\]`));
  if (!match) throw new Error(`\`${name}\` not found in @cloudflare/vite-plugin`);
  return [...match[1]!.matchAll(/"([^"]*)"/g)].map((element) => element[1]!);
};

describe("ported constants match @cloudflare/vite-plugin", () => {
  it("forwards the same handlers on each export type", async () => {
    const runner = await read("workers/runner-worker/index.js");
    expect([...IGNORED_KEYS]).toEqual(arrayLiteral(runner, "IGNORED_KEYS"));
    expect([...WORKER_ENTRYPOINT_KEYS]).toEqual(arrayLiteral(runner, "WORKER_ENTRYPOINT_KEYS"));
    expect([...DURABLE_OBJECT_KEYS]).toEqual(arrayLiteral(runner, "DURABLE_OBJECT_KEYS"));
    expect([...WORKFLOW_ENTRYPOINT_KEYS]).toEqual(arrayLiteral(runner, "WORKFLOW_ENTRYPOINT_KEYS"));
  });

  it("treats the same modules as runtime built-ins", async () => {
    const plugin = await read("index.mjs");
    const upstream = arrayLiteral(plugin, "cloudflareBuiltInModules");
    // Built-ins upstream has added on `main` after the installed release.
    const ahead = AHEAD_OF_RELEASE_BUILT_IN_MODULES.filter((id) => !upstream.includes(id));
    expect([...CLOUDFLARE_BUILT_IN_MODULES].sort()).toEqual([...upstream, ...ahead].sort());
  });

  // v2 takes its default rules from `@cloudflare/config`, as globs
  // (`**/*.txt`), where v1 had regular expressions. Each glob's file type
  // must resolve to the same module type here, and every type must exist on
  // both sides.
  it("imports the same additional module types", async () => {
    const plugin = await read("index.mjs");
    const block = plugin.match(/var DEFAULT_MODULE_RULES = \[([\s\S]*?)\n\];/)?.[1];
    expect(block).toBeDefined();
    const upstream = [...block!.matchAll(/type: "(\w+)",\s*globs: \[([^\]]*)\]/g)].flatMap(
      ([, type, globs]) =>
        [...globs!.matchAll(/"\*\*\/\*([^"]+)"/g)].map(([, suffix]) => ({
          type,
          file: `file${suffix}`,
        })),
    );
    expect(upstream.length).toBeGreaterThan(0);
    const typeOf = (file: string) =>
      MODULE_RULES.filter((rule) => rule.pattern.test(file)).map((rule) => rule.type);
    expect(upstream.map(({ file }) => ({ file, types: typeOf(file) }))).toEqual(
      upstream.map(({ type, file }) => ({ file, types: [type] })),
    );
    expect(new Set(MODULE_RULES.map((rule) => rule.type))).toEqual(
      new Set(upstream.map(({ type }) => type)),
    );
  });

  it("recognizes the same Sandbox preview origins", async () => {
    const plugin = await read("index.mjs");
    const source = plugin.match(/const SANDBOX_ORIGIN_REGEXP = \/(.*)\/(\w*);/);
    expect(source).not.toBeNull();
    expect(SANDBOX_ORIGIN_REGEXP.source).toBe(source![1]);
    expect(SANDBOX_ORIGIN_REGEXP.flags).toBe(source![2]);
  });
});
