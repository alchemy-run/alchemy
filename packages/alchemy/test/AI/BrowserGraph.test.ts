/**
 * `alchemy/AI/React` is imported by browser bundles (the org UI's SPA
 * builds it with Vite). Its static import graph must therefore stay clear
 * of the ENGINE ROOT: `Output.ts` reaches `Stack`, `State`, and the
 * terminal UI (`Interaction` → `Util/Terminal` → `@alchemy.run/sigil`),
 * which reads `process.env` at module scope and throws in a browser
 * before the app renders.
 *
 * Plan/runtime seams that need an `Output` from inside the AI graph go
 * through `RuntimeLiteral` (`RuntimeContext.ts`) — see `AI/Source.ts`.
 * This walk is the guard: a value import that reintroduces the engine
 * fails here, with the chain, instead of in a Playwright suite.
 */
import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

const ENTRY = "src/AI/React.ts";

/** Modules the browser graph must never reach — the engine root and the
 *  terminal library behind it. */
const FORBIDDEN = [
  "src/Output.ts",
  "src/Stack.ts",
  "src/Interaction.ts",
  "src/Util/Terminal.ts",
  "@alchemy.run/sigil",
];

// value imports only: `import type` / `export type` are erased; dynamic
// `import()` is a deliberate lazy edge and not part of the static graph.
const importRe =
  /(?:import|export)\s+(?!type\s)[^'"]*?\s*from\s*["']([^"']+)["']|^import\s+["']([^"']+)["']/gm;

describe("AI browser import graph", () => {
  it.effect("alchemy/AI/React never reaches the engine root", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* Effect.sync(() => process.cwd());
      const rel = (file: string) => path.relative(root, file);

      const parent = new Map<string, string | undefined>();
      const start = path.resolve(root, ENTRY);
      parent.set(start, undefined);
      const queue = [start];

      const chainTo = (file: string): string[] => {
        const chain: string[] = [];
        for (let f: string | undefined = file; f; f = parent.get(f)) {
          chain.unshift(rel(f));
        }
        return chain;
      };

      while (queue.length > 0) {
        const file = queue.shift()!;
        const source = yield* fs
          .readFileString(file)
          .pipe(Effect.catch(() => Effect.succeed("")));
        for (const match of source.matchAll(importRe)) {
          const spec = match[1] ?? match[2];
          if (spec === undefined) continue;
          const hit = FORBIDDEN.find((f) =>
            spec.startsWith(".")
              ? rel(path.resolve(path.dirname(file), spec)) === f
              : spec.startsWith(f),
          );
          if (hit !== undefined) {
            expect.fail(
              `${ENTRY} reaches ${hit} through a value import:\n  ` +
                [...chainTo(file), hit].join("\n  -> "),
            );
          }
          if (!spec.startsWith(".")) continue;
          let target = path.resolve(path.dirname(file), spec);
          if (!/\.(ts|tsx|js)$/.test(target)) target += ".ts";
          if (!parent.has(target)) {
            parent.set(target, file);
            queue.push(target);
          }
        }
      }
      // sanity: the walk actually covered the AI graph
      expect(parent.size).toBeGreaterThan(10);
    }).pipe(Effect.provide(BunServices.layer)),
  );
});
