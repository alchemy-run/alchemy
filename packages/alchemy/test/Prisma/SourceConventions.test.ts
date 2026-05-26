import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

const forbiddenPatterns = [
  {
    name: "raw filesystem/path/os imports",
    pattern:
      /\bfrom\s+["'](?:node:fs|node:fs\/promises|node:path|node:os|pathe)["']/,
  },
  {
    name: "async/await",
    pattern: /\b(?:async|await)\b/,
  },
  {
    name: "Effect.orDie",
    pattern: /\bEffect\.orDie\b/,
  },
  {
    name: "legacy create/update lifecycle handlers",
    pattern: /\b(?:create|update)\s*:\s*Effect\.fn\b/,
  },
  {
    name: "explicit output undefined create/update branch",
    pattern:
      /\b(?:output\s*(?:===|!==)\s*undefined|undefined\s*(?:===|!==)\s*output)\b/,
  },
  {
    name: "bare process.cwd()",
    pattern: /\bprocess\.cwd\(\)/,
  },
  {
    name: "explicit any",
    pattern: /\bany\b/,
  },
  {
    name: "double unknown cast",
    pattern: /\bas\s+unknown\s+as\b/,
  },
] as const;

const documentedResources = [
  "Branch",
  "Compute",
  "ComputeService",
  "ComputeVersion",
  "Connection",
  "Database",
  "EnvironmentVariable",
  "Project",
  "SourceRepository",
] as const;

const stripStrings = (source: string) =>
  source
    .replaceAll(/`(?:\\.|[^`])*`/gs, "``")
    .replaceAll(/"(?:\\.|[^"])*"/g, '""')
    .replaceAll(/'(?:\\.|[^'])*'/g, "''");

describe("Prisma source conventions", () => {
  it.effect("keeps provider source in Effect-style lifecycle conventions", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const sourceRoot = path.resolve(import.meta.dirname, "../../src/Prisma");
      const files = (yield* fs.readDirectory(sourceRoot, { recursive: true }))
        .filter((file) => file.endsWith(".ts"))
        .sort();

      const violations: string[] = [];
      for (const file of files) {
        const fullPath = path.join(sourceRoot, file);
        const source = yield* fs.readFileString(fullPath);
        for (const { name, pattern } of forbiddenPatterns) {
          const scannedSource =
            name === "raw filesystem/path/os imports"
              ? source
              : stripStrings(source);
          const match = pattern.exec(scannedSource);
          if (match) {
            violations.push(`${file}: ${name}: ${match[0]}`);
          }
        }
      }

      expect(violations).toEqual([]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps Prisma resources ready for generated API docs", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const sourceRoot = path.resolve(import.meta.dirname, "../../src/Prisma");

      for (const resource of documentedResources) {
        const source = yield* fs.readFileString(
          path.join(sourceRoot, `${resource}.ts`),
        );
        expect(source).toContain(`export interface ${resource}Props`);
        const constructorPattern =
          resource === "Compute"
            ? `export const ${resource}: Platform<`
            : `export const ${resource} = Resource<`;
        expect(source).toContain(constructorPattern);

        const resourceDoc = source.match(
          new RegExp(
            resource === "Compute"
              ? `/\\*\\*[\\s\\S]*?\\*/\\s*export const ${resource}: Platform<`
              : `/\\*\\*[\\s\\S]*?\\*/\\s*export const ${resource} = Resource<`,
          ),
        )?.[0];
        if (resourceDoc === undefined) {
          throw new Error(`${resource} is missing resource JSDoc`);
        }
        expect(resourceDoc).toContain("@section");
        expect(resourceDoc).toContain("@example");
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
