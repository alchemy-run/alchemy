/**
 * UI registry conformance + coverage.
 *
 * Conformance: every UIProvider in the full merged registry (all clouds)
 * is executed against the contexts the dashboard actually renders —
 * "declared but never deployed" (attrs/props undefined) and "partially
 * persisted" (empty objects). A provider whose callbacks throw there
 * crashes a canvas card at runtime; a provider with an unknown lucide
 * icon silently renders the box fallback. Both fail here instead.
 *
 * Coverage: every `Resource<...>("Cloud.Type")` declared in a cloud the
 * dashboard registers must have a UIProvider — the one-off census that
 * brought AWS to 691/691 is enforced permanently, so a new resource
 * cannot land without dashboard UI.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import dynamicIconImports from "lucide-react/dynamicIconImports";
import type {
  ResourceUIContext,
  UICategory,
  UIRegistry,
} from "alchemy/UI/UIProvider";
import { loadRegistry } from "../src/registry.ts";

const LUCIDE_ICONS = new Set(Object.keys(dynamicIconImports));

const CATEGORIES = new Set<UICategory>([
  "compute",
  "storage",
  "database",
  "network",
  "dns",
  "queue",
  "eventing",
  "ai",
  "auth",
  "security",
  "observability",
  "cdn",
  "email",
  "media",
  "config",
  "billing",
  "other",
]);

/** The clouds `loadRegistry` wires in — coverage is enforced for these. */
const REGISTERED_CLOUDS = [
  "AWS",
  "Axiom",
  "Cloudflare",
  "Docker",
  "GitHub",
  "Neon",
  "Planetscale",
] as const;

const ctxOf = (
  type: string,
  overrides: Partial<ResourceUIContext>,
): ResourceUIContext => ({
  fqn: `app/${type}`,
  logicalId: type.split(".").at(-1) ?? type,
  type,
  status: "created",
  stack: "app",
  stage: "test",
  bindings: [],
  downstream: [],
  ...overrides,
});

const registryPromise: Promise<UIRegistry> = loadRegistry();

describe("UI registry conformance", () => {
  test("the merged registry is substantial (import wiring intact)", async () => {
    const registry = await registryPromise;
    // 691 AWS + 237 Cloudflare + the smaller clouds; a broken cloud
    // import silently shrinking the registry must fail loudly.
    expect(registry.providers.size).toBeGreaterThan(900);
  });

  test("every provider's metadata is valid", async () => {
    const registry = await registryPromise;
    const problems: string[] = [];
    for (const [type, ui] of registry.providers) {
      if (typeof ui.icon === "string" && !LUCIDE_ICONS.has(ui.icon)) {
        problems.push(`${type}: unknown lucide icon "${ui.icon}"`);
      }
      if (ui.color !== undefined && !/^#[0-9a-fA-F]{6}$/.test(ui.color)) {
        problems.push(`${type}: color "${ui.color}" is not a #rrggbb hex`);
      }
      if (ui.category !== undefined && !CATEGORIES.has(ui.category)) {
        problems.push(`${type}: category "${ui.category}" not in UICategory`);
      }
      if (ui.displayName !== undefined && ui.displayName.trim() === "") {
        problems.push(`${type}: empty displayName`);
      }
    }
    expect(problems).toEqual([]);
  });

  test("every provider's callbacks are total on undeployed and empty state", async () => {
    const registry = await registryPromise;
    const problems: string[] = [];
    // The two shapes the dashboard genuinely renders before/during a
    // first deploy: nothing persisted at all, and empty objects.
    const contexts = (type: string) => [
      ctxOf(type, { props: undefined, attrs: undefined }),
      ctxOf(type, { props: {}, attrs: {} }),
    ];
    for (const [type, ui] of registry.providers) {
      for (const ctx of contexts(type)) {
        try {
          const summary = ui.summary?.(ctx);
          if (summary !== undefined && typeof summary !== "string") {
            problems.push(`${type}: summary returned ${typeof summary}`);
          }
          for (const key of ["link", "consoleUrl"] as const) {
            const url = ui[key]?.(ctx);
            if (url === undefined) {
              continue;
            }
            if (typeof url !== "string") {
              problems.push(`${type}: ${key} returned ${typeof url}`);
            } else if (url.includes("undefined") || url.includes("null")) {
              problems.push(
                `${type}: ${key} interpolated a missing value: ${url}`,
              );
            }
          }
          const facts = ui.facts?.(ctx) ?? [];
          if (!Array.isArray(facts)) {
            problems.push(`${type}: facts did not return an array`);
            continue;
          }
          for (const fact of facts) {
            if (typeof fact.label !== "string" || fact.label.trim() === "") {
              problems.push(`${type}: fact with empty label`);
            }
            if (
              fact.value !== undefined &&
              !["string", "number", "boolean"].includes(typeof fact.value)
            ) {
              problems.push(
                `${type}: fact "${fact.label}" value is ${typeof fact.value}`,
              );
            }
          }
        } catch (error) {
          problems.push(
            `${type}: threw on ${ctx.attrs === undefined ? "undeployed" : "empty"} state: ${String(error)}`,
          );
        }
      }
    }
    expect(problems).toEqual([]);
  });
});

// ── coverage: every declared resource type renders ─────────────────────────

const SRC = resolve(import.meta.dirname, "../../alchemy/src");

const walk = (dir: string, out: string[] = []): string[] => {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      walk(path, out);
    } else if (entry.endsWith(".ts")) {
      out.push(path);
    }
  }
  return out;
};

describe("UI registry coverage", () => {
  test("every Resource declared in a registered cloud has a UIProvider", async () => {
    const registry = await registryPromise;
    const prefixes = REGISTERED_CLOUDS.map((cloud) => `${cloud}.`);
    const declared = new Map<string, string>();
    for (const cloud of REGISTERED_CLOUDS) {
      const dir = join(SRC, cloud);
      let files: string[];
      try {
        files = walk(dir);
      } catch {
        continue;
      }
      for (const file of files) {
        const source = readFileSync(file, "utf8");
        for (const match of source.matchAll(
          /\bResource\s*<[^(]*?>\s*\(\s*"([A-Za-z0-9._-]+)"/gs,
        )) {
          const tag = match[1]!;
          if (prefixes.some((prefix) => tag.startsWith(prefix))) {
            declared.set(tag, file.slice(SRC.length + 1));
          }
        }
      }
    }
    // Sanity: the scan itself must keep finding the fleet's coverage —
    // a regex rot that finds 0 resources would pass a naive subset check.
    expect(declared.size).toBeGreaterThan(700);

    const missing = [...declared]
      .filter(([tag]) => registry.get(tag) === undefined)
      .map(([tag, file]) => `${tag} (${file})`)
      .sort();
    expect(missing).toEqual([]);
  });
});
