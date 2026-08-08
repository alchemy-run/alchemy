/**
 * Enforces the deploy-target decoupling contract: the framework-generic
 * modules (`SvelteKit.ts`, `index.ts`) must contain ZERO Cloudflare-specific
 * imports. Everything platform-specific (the adapter fork, the worker shim,
 * the rolldown finishing pass) lives behind the `./cloudflare` subpath
 * module.
 */
import * as NodeFs from "node:fs";
import * as NodePath from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const srcDir = NodePath.resolve(
  NodePath.dirname(fileURLToPath(import.meta.url)),
  "..",
);

/** Every static import / re-export specifier in a module's source. */
const importSpecifiers = (file: string): Array<string> => {
  const source = NodeFs.readFileSync(NodePath.join(srcDir, file), "utf8");
  const specifiers: Array<string> = [];
  // `import ... from "x"`, `export ... from "x"`, and bare `import "x"`.
  const pattern =
    /(?:^|\n)\s*(?:import|export)\s+(?:[^"'\n]*?from\s*)?["']([^"']+)["']/g;
  for (const match of source.matchAll(pattern)) {
    specifiers.push(match[1] as string);
  }
  return specifiers;
};

// Cloudflare-specific dependency surface: platform packages, the bundler for
// the workerd finishing pass, and the in-package cloudflare modules.
const FORBIDDEN = [
  /^@alchemy\.run\/cloudflare-runtime(?:\/|$)/,
  /^@cloudflare\//,
  /^cloudflare:/,
  /^\.\/cloudflare(?:\.ts)?$/,
  /^rolldown$/,
  /\/Adapter(\.ts)?$/,
  /\.\/Adapter/,
  /\.\/WorkerShim/,
];

const FRAMEWORK_GENERIC_MODULES = ["SvelteKit.ts", "UserConfig.ts", "index.ts"];

describe("target decoupling", () => {
  for (const file of FRAMEWORK_GENERIC_MODULES) {
    it(`${file} imports nothing Cloudflare-specific`, () => {
      const specifiers = importSpecifiers(file);
      expect(specifiers.length).toBeGreaterThan(0);
      const offending = specifiers.filter((specifier) =>
        FORBIDDEN.some((pattern) => pattern.test(specifier)),
      );
      expect(offending).toEqual([]);
    });
  }

  it("cloudflare.ts is the only src module importing the adapter and rolldown", () => {
    const files = NodeFs.readdirSync(srcDir).filter((file) =>
      file.endsWith(".ts"),
    );
    for (const file of files) {
      if (
        file === "cloudflare.ts" ||
        file === "Adapter.ts" ||
        file === "WorkerShim.ts"
      )
        continue;
      // `source.ts` is Cloudflare-specific by contract (it implements
      // alchemy's Cloudflare Worker source) — it may import ./cloudflare.ts
      // but must not reach around it to the adapter/bundler internals.
      const specifiers = importSpecifiers(file);
      const offending = specifiers.filter(
        (specifier) =>
          /^rolldown$/.test(specifier) ||
          /\.\/Adapter/.test(specifier) ||
          /\.\/WorkerShim/.test(specifier) ||
          /@alchemy\.run\/cloudflare-runtime/.test(specifier),
      );
      expect(
        offending,
        `${file} must not import ${offending.join(", ")}`,
      ).toEqual([]);
    }
  });
});
