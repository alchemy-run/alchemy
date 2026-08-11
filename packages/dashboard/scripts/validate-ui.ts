/**
 * Validate dashboard UI provider modules (see processes/Dashboard.md).
 *
 * Usage (from packages/dashboard):
 *   bun scripts/validate-ui.ts ../alchemy/src/AWS/S3/ui.ts [...more]
 *   bun scripts/validate-ui.ts --all          # every ui.ts / {Cloud}/UI.ts
 *
 * Checks, per module:
 *   1. loads in a browser-ish context and exports `ui(): Layer`
 *   2. the layer builds into a registry (no failing effects)
 *   3. every registered type tag matches a real `Resource(...)` tag in
 *      packages/alchemy/src (catches guessed tags like
 *      "Cloudflare.Workers.Worker" — the real tag is "Cloudflare.Worker")
 *   4. every string icon is a valid lucide-react icon name
 *   5. runtime imports are browser-safe (only effect/*, react, the
 *      UIProvider module, sibling ui modules) — resource modules must be
 *      `import type` only
 *
 * Exit code 1 if any ERROR; warnings don't fail.
 */
import * as Effect from "effect/Effect";
import { iconNames } from "lucide-react/dynamic";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = path.resolve(import.meta.dir, "../../..");
const alchemySrc = path.join(repoRoot, "packages/alchemy/src");

// ---------------------------------------------------------------- tags
const collectResourceTags = (): Set<string> => {
  const tags = new Set<string>();
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(p);
      } else if (e.name.endsWith(".ts") || e.name.endsWith(".tsx")) {
        const text = fs.readFileSync(p, "utf8");
        // Resource<X>("Cloud.Service.Type") / Platform("Cloud.Type", ...)
        for (const m of text.matchAll(
          /(?:Resource<[^(]*>|Platform)\(\s*"([^"]+)"/g,
        )) {
          tags.add(m[1]!);
        }
        // const TypeId = "..." ... Resource<X>(TypeId) / Platform(TypeId, ...)
        const consts = new Map<string, string>();
        for (const m of text.matchAll(
          /(?:const|let)\s+(\w+)\s*=\s*"([^"]+)"/g,
        )) {
          consts.set(m[1]!, m[2]!);
        }
        for (const m of text.matchAll(
          /(?:Resource<[^(]*>|Platform)\(\s*(\w+)\s*[,)]/g,
        )) {
          const v = consts.get(m[1]!);
          if (v) {
            tags.add(v);
          }
        }
      }
    }
  };
  walk(alchemySrc);
  return tags;
};

// ------------------------------------------------------------- imports
const SAFE_SPECIFIER =
  /^(effect(\/|$)|react($|\/)|lucide-react(\/|$)|@xyflow\/)/;

const checkImports = (file: string): string[] => {
  const errors: string[] = [];
  const text = fs.readFileSync(file, "utf8");
  const importRe = /^import\s+(type\s+)?[^"']*from\s*["']([^"']+)["']/gm;
  for (const m of text.matchAll(importRe)) {
    const isType = m[1] !== undefined;
    const spec = m[2]!;
    if (isType) {
      continue;
    }
    const ok =
      SAFE_SPECIFIER.test(spec) ||
      /UI\/UIProvider(\.ts)?$/.test(spec) ||
      /\/ui(-components)?(\.tsx?)?$/.test(spec) ||
      spec.startsWith("./ui");
    if (!ok) {
      errors.push(
        `runtime import of "${spec}" — resource/SDK modules must be \`import type\` only (browser bundle safety)`,
      );
    }
  }
  return errors;
};

// ----------------------------------------------------------------- main
const findAll = (): string[] => {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(p);
      } else if (
        e.name === "ui.ts" ||
        (e.name === "UI.ts" && path.dirname(p) !== alchemySrc)
      ) {
        out.push(p);
      }
    }
  };
  walk(alchemySrc);
  return out;
};

const argPaths = process.argv.slice(2);
const files = argPaths.includes("--all")
  ? findAll()
  : argPaths.map((a) => path.resolve(process.cwd(), a));

if (files.length === 0) {
  console.error("usage: bun scripts/validate-ui.ts <ui.ts files...> | --all");
  process.exit(2);
}

const validTags = collectResourceTags();
const icons = new Set<string>(iconNames as readonly string[]);
let errorCount = 0;
let warnCount = 0;
let providerTotal = 0;
let stubCount = 0;

const { buildRegistry } = await import(
  pathToFileURL(path.join(alchemySrc, "UI/UIProvider.ts")).href
);

for (const file of files) {
  const rel = path.relative(repoRoot, file);
  const problems: { level: "ERROR" | "WARN"; msg: string }[] = [];
  const err = (msg: string) => problems.push({ level: "ERROR", msg });
  const warn = (msg: string) => problems.push({ level: "WARN", msg });

  for (const e of checkImports(file)) {
    err(e);
  }

  let providers = new Map<string, any>();
  try {
    const mod = await import(pathToFileURL(file).href);
    if (typeof mod.ui !== "function") {
      err("does not export `ui()`");
    } else {
      const registry: any = await Effect.runPromise(buildRegistry(mod.ui()));
      providers = registry.providers;
    }
  } catch (e) {
    err(`failed to load/build: ${e}`);
  }

  if (
    providers.size === 0 &&
    fs.readFileSync(file, "utf8").includes("Layer.empty")
  ) {
    stubCount++;
    console.log(`STUB  ${rel}`);
    continue;
  }

  providerTotal += providers.size;
  for (const [tag, svc] of providers) {
    if (!validTags.has(tag)) {
      err(
        `registered tag "${tag}" does not match any Resource(...) tag in packages/alchemy/src`,
      );
    }
    if (typeof svc.icon === "string" && !icons.has(svc.icon)) {
      err(`"${tag}": icon "${svc.icon}" is not a lucide-react icon name`);
    }
    if (svc.category === undefined) {
      warn(`"${tag}": no category set`);
    }
  }

  if (problems.length === 0) {
    console.log(`OK    ${rel} (${providers.size} providers)`);
  } else {
    console.log(
      `${problems.some((p) => p.level === "ERROR") ? "FAIL " : "WARN "} ${rel} (${providers.size} providers)`,
    );
    for (const p of problems) {
      console.log(`      ${p.level}: ${p.msg}`);
      if (p.level === "ERROR") {
        errorCount++;
      } else {
        warnCount++;
      }
    }
  }
}

console.log(
  `\n${files.length} files, ${providerTotal} providers, ${stubCount} stubs remaining, ${errorCount} errors, ${warnCount} warnings`,
);
process.exit(errorCount > 0 ? 1 : 0);
