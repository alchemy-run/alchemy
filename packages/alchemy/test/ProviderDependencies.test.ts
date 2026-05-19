import { builtinModules } from "node:module";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import pkg from "../package.json";
import {
  cloudflareStateStoreDependencyGroup,
  combineDependencyGroups,
  coreDependencyGroup,
  dependencyGroups,
  makeAddCommand,
  optionalPeerDependencyPackages,
  requiredPeerDependencyPackages,
} from "@/ProviderDependencies";

const packageRoot = new URL("..", import.meta.url).pathname;
const sourceRoot = path.join(packageRoot, "src");
const staticImportPattern =
  /(?:^|\n)\s*(import|export)\s+(type\s+)?[^;]*?\s+from\s+["']([^"']+)["']\s*;/g;
const sideEffectImportPattern = /(?:^|\n)\s*import\s+["']([^"']+)["']\s*;/g;
const dynamicImportPattern = /import\(["']([^"']+)["']\)/g;
const ignoredSpecifierPrefixes = [".", "@/", "node:", "bun:", "cloudflare:"];
const builtinPackages = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
]);
const typePackageByRuntimeSpecifier: Record<string, string> = {
  "aws-lambda": "@types/aws-lambda",
};

const packageNameFromSpecifier = (specifier: string) => {
  if (specifier.startsWith("@")) {
    const [scope, name] = specifier.split("/");
    return `${scope}/${name}`;
  }
  return specifier.split("/")[0]!;
};

const listSourceFiles = (directory: string): string[] =>
  readdirSync(directory).flatMap((entry) => {
    const absolute = path.join(directory, entry);
    const status = statSync(absolute);
    if (status.isDirectory()) return listSourceFiles(absolute);
    return /\.tsx?$/.test(entry) ? [absolute] : [];
  });

const sourceImports = () => {
  const valuePackages = new Set<string>();
  const typePackages = new Set<string>();
  for (const file of listSourceFiles(sourceRoot)) {
    const source = readFileSync(file, "utf8");
    for (const staticMatch of source.matchAll(staticImportPattern)) {
      const specifier = staticMatch[3]!;
      if (
        ignoredSpecifierPrefixes.some((prefix) => specifier.startsWith(prefix))
      ) {
        continue;
      }
      const packageName = packageNameFromSpecifier(specifier);
      if (builtinPackages.has(packageName)) continue;
      const mapped = typePackageByRuntimeSpecifier[packageName] ?? packageName;
      if (staticMatch[2]) typePackages.add(mapped);
      else valuePackages.add(mapped);
    }
    for (const sideEffectMatch of source.matchAll(sideEffectImportPattern)) {
      const specifier = sideEffectMatch[1]!;
      if (
        ignoredSpecifierPrefixes.some((prefix) => specifier.startsWith(prefix))
      ) {
        continue;
      }
      const packageName = packageNameFromSpecifier(specifier);
      if (builtinPackages.has(packageName)) continue;
      valuePackages.add(packageName);
    }
    for (const dynamicMatch of source.matchAll(dynamicImportPattern)) {
      const specifier = dynamicMatch[1]!;
      if (
        ignoredSpecifierPrefixes.some((prefix) => specifier.startsWith(prefix))
      ) {
        continue;
      }
      const packageName = packageNameFromSpecifier(specifier);
      if (builtinPackages.has(packageName)) continue;
      const lineStart = source.lastIndexOf("\n", dynamicMatch.index) + 1;
      const linePrefix = source.slice(lineStart, dynamicMatch.index);
      const mapped = typePackageByRuntimeSpecifier[packageName] ?? packageName;
      if (/\b(type|interface)\b/.test(linePrefix)) {
        typePackages.add(mapped);
      } else {
        valuePackages.add(packageName);
      }
    }
  }
  valuePackages.delete("alchemy");
  typePackages.delete("alchemy");
  return {
    valuePackages: [...valuePackages].sort(),
    typePackages: [...typePackages].sort(),
  };
};

describe("provider dependency groups", () => {
  test("required peer dependencies are not marked optional", () => {
    for (const packageName of requiredPeerDependencyPackages) {
      expect(pkg.peerDependencies).toHaveProperty(packageName);
      expect(pkg.peerDependenciesMeta).not.toHaveProperty(packageName);
    }
  });

  test("optional peer dependency metadata matches the dependency contract", () => {
    expect(Object.keys(pkg.peerDependenciesMeta).sort()).toEqual(
      [...optionalPeerDependencyPackages].sort(),
    );
  });

  test("stale packages removed from source are absent from install surfaces", () => {
    const surfaces = [
      pkg.peerDependencies,
      pkg.peerDependenciesMeta,
      pkg.devDependencies,
    ];
    for (const surface of surfaces) {
      expect(surface).not.toHaveProperty("@ai-sdk/provider");
      expect(surface).not.toHaveProperty("ai");
      expect(surface).not.toHaveProperty("ignore");
      expect(surface).not.toHaveProperty("web-tree-sitter");
    }
  });

  test("cloudflare state-store installs combine resource and worker packaging groups", () => {
    expect(cloudflareStateStoreDependencyGroup.packages).toEqual([
      ...dependencyGroups.cloudflare.packages,
      ...dependencyGroups.cloudflareWorkerRuntime.packages,
    ]);
  });

  test("install command generation preserves first occurrence order", () => {
    const packages = combineDependencyGroups([
      coreDependencyGroup,
      dependencyGroups.cloudflare,
      dependencyGroups.cloudflareWorkerRuntime,
    ]);
    expect(makeAddCommand(packages)).toBe(
      "bun add alchemy effect @effect/platform-bun @effect/platform-node @cloudflare/workers-types @distilled.cloud/cloudflare @distilled.cloud/core @distilled.cloud/cloudflare-runtime @distilled.cloud/cloudflare-vite-plugin @distilled.cloud/cloudflare-rolldown-plugin vite",
    );
  });

  test("direct source value imports are declared as dependencies or peers", () => {
    const declared = new Set([
      ...Object.keys(pkg.dependencies),
      ...Object.keys(pkg.peerDependencies),
    ]);
    expect(
      sourceImports().valuePackages.filter((name) => !declared.has(name)),
    ).toEqual([]);
  });

  test("direct source type imports are declared as dependencies, peers, or development type inputs", () => {
    const declared = new Set([
      ...Object.keys(pkg.dependencies),
      ...Object.keys(pkg.peerDependencies),
      ...Object.keys(pkg.devDependencies),
    ]);
    expect(
      sourceImports().typePackages.filter((name) => !declared.has(name)),
    ).toEqual([]);
  });
});
