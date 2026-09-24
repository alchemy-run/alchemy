import { describe, expect, test } from "alchemy-test";
import * as fs from "node:fs";
import * as path from "node:path";

// `@alchemy.run/frontend-frameworks` is an optional peer dependency. These
// entrypoints re-export a `Website` namespace, so anything they load at
// runtime must not import it statically — importing `alchemy/Prisma` (say)
// would then fail for every consumer that never installed it.
const ENTRYPOINTS = ["Prisma", "Neon", "Fly", "Hetzner", "Railway"];
const OPTIONAL_PEER = "@alchemy.run/frontend-frameworks";

const src = path.resolve(import.meta.dirname, "../../src");

const transpiler = new Bun.Transpiler({ loader: "ts" });

/** Static runtime import and re-export specifiers of `file` — type-only ones are erased, dynamic imports are lazy. */
const runtimeSpecifiers = (file: string): string[] =>
  transpiler
    .scanImports(fs.readFileSync(file, "utf8"))
    .filter((entry) => entry.kind !== "dynamic-import")
    .map((entry) => entry.path);

/** Every bare specifier reachable from `entry` through relative runtime imports. */
const reachableBareImports = (entry: string): Map<string, string> => {
  const bare = new Map<string, string>();
  const seen = new Set<string>();
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const specifier of runtimeSpecifiers(file)) {
      if (specifier.startsWith(".")) {
        visit(path.resolve(path.dirname(file), specifier));
      } else if (!bare.has(specifier)) {
        bare.set(specifier, path.relative(src, file));
      }
    }
  };
  visit(entry);
  return bare;
};

describe(
  "optional frontend-frameworks peer",
  { tags: ["unit", "local"] },
  () => {
    for (const provider of ENTRYPOINTS) {
      test(`alchemy/${provider} does not import ${OPTIONAL_PEER} statically`, () => {
        const offenders = [
          ...reachableBareImports(path.join(src, provider, "index.ts")),
        ]
          .filter(
            ([specifier]) =>
              specifier === OPTIONAL_PEER ||
              specifier.startsWith(`${OPTIONAL_PEER}/`),
          )
          .map(([specifier, file]) => `${file} -> ${specifier}`);
        expect(offenders).toEqual([]);
      });
    }
  },
);
