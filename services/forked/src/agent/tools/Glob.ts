import * as AI from "alchemy/AI";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as S from "effect/Schema";
import { Sandbox } from "../Sandbox.ts";

const LIMIT = 100;

export const pattern = AI.Parameter("pattern", S.String)`
The glob pattern to match files against.`;

export const path = AI.Parameter("path")(S.String.pipe(S.optional))`
The directory to search in, relative to the workspace root. If not specified,
the workspace root is used. IMPORTANT: Omit this field to use the default
directory. DO NOT enter "undefined" or "null" — simply omit it for the default
behavior.`;

export class Glob extends AI.Tool<Glob>()("glob")`
- Fast file pattern matching tool that works with any codebase size
- Supports glob ${pattern}s like \`**/*.js\` or \`src/**/*.ts\`
- Returns matching file paths sorted by most recently modified
- Optionally scopes the search to ${path}
- Use this tool when you need to find files by name patterns
- You have the capability to call multiple tools in a single response. It is
  always better to speculatively perform multiple searches as a batch that are
  potentially useful.` {}

export const GlobLive = Layer.effect(
  Glob,
  Effect.gen(function* () {
    const sandbox = yield* Sandbox;
    return Effect.fn("glob")(function* (params) {
      const { pattern, path } = params as { pattern: string; path?: string };
      const result = yield* sandbox.exec(
        `rg --files --glob ${shellQuote(pattern)} --sortr modified | head -n ${LIMIT}`,
        { cwd: path },
      );
      const files = result.stdout.split("\n").filter(Boolean);
      return {
        count: files.length,
        truncated: files.length >= LIMIT,
        output: files.length ? files.join("\n") : "No files found",
      };
    });
  }),
);

const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
