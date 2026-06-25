import * as AI from "alchemy/AI";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as S from "effect/Schema";
import { Sandbox } from "../Sandbox.ts";

const LIMIT = 100;

export const pattern = AI.Parameter("pattern", S.String)`
The regex pattern to search for in file contents.`;

export const path = AI.Parameter("path")(S.String.pipe(S.optional))`
The directory to search in, relative to the workspace root. Defaults to the
workspace root.`;

export const include = AI.Parameter("include")(S.String.pipe(S.optional))`
File pattern to include in the search (e.g. \`*.js\`, \`*.{ts,tsx}\`).`;

export class Grep extends AI.Tool<Grep>()("grep")`
- Fast content search tool that works with any codebase size
- Searches file contents using a regular expression ${pattern}
- Supports full regex syntax (e.g. \`log.*Error\`, \`function\\s+\\w+\`)
- Filter files with the ${include} parameter (e.g. \`*.js\`, \`*.{ts,tsx}\`)
- Optionally scopes the search to ${path}
- Returns file paths and line numbers with matching lines
- Use this tool when you need to find files containing specific patterns
- If you need to identify/count the number of matches within files, use the
  bash tool with \`rg\` (ripgrep) directly.` {}

export const GrepLive = Layer.effect(
  Grep,
  Effect.gen(function* () {
    const sandbox = yield* Sandbox;
    return Effect.fn("grep")(function* (params) {
      const { pattern, path, include } = params as {
        pattern: string;
        path?: string;
        include?: string;
      };
      const flags = include ? `--glob ${shellQuote(include)}` : "";
      const result = yield* sandbox.exec(
        `rg --line-number --no-heading ${flags} ${shellQuote(pattern)} | head -n ${LIMIT}`,
        { cwd: path },
      );
      const matches = result.stdout.split("\n").filter(Boolean);
      return {
        matches: matches.length,
        truncated: matches.length >= LIMIT,
        output: matches.length ? matches.join("\n") : "No files found",
      };
    });
  }),
);

const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
