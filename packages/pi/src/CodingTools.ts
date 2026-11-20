import * as AI from "@alchemy.run/ai";
import { Sandbox, Sandboxes } from "@alchemy.run/ai/Sandbox";
import type { ToolTagClass } from "@alchemy.run/ai/Tool";
import { CodingTools as PiCodingTools } from "@earendil-works/pi-durable/tools";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { ENGINE, type NativeTool } from "./Tool.ts";

/**
 * One of Pi's own tools as the implementation of a tool tag. It works on
 * files or a shell, so the Layer requires `AI.Sandboxes`.
 */
const native = <Self>(tag: ToolTagClass<Self, string>): Layer.Layer<Self, never, Sandboxes> =>
  Layer.unwrap(
    Effect.gen(function* () {
      const sandboxes = yield* Sandboxes;
      const registration = (PiCodingTools.tools ?? []).find((tool) => tool.name === tag.toolName);
      if (registration === undefined) {
        return yield* Effect.die(new Error(`Pi's coding tools have no "${tag.toolName}"`));
      }
      return tag.native(ENGINE, { registration, sandboxes } satisfies NativeTool);
    }),
  );

/** Pi's `bash` as `AI.Bash`: run a shell command in the conversation's sandbox. */
export const BashLive = native(AI.Bash);
/** Pi's `read` as `AI.Read`: text with line numbers, or an image. */
export const ReadLive = native(AI.Read);
/** Pi's `edit` as `AI.Edit`: replace exact text in a file. */
export const EditLive = native(AI.Edit);
/** Pi's `write` as `AI.Write`: write a whole file, creating its directories. */
export const WriteLive = native(AI.Write);

const MAX_LINES = 200;

const lines = (text: string) => {
  const all = text.split("\n").filter((line) => line.length > 0);
  return {
    matches: all.slice(0, MAX_LINES),
    truncated: all.length > MAX_LINES,
  };
};

const Found = Schema.Struct({
  matches: Schema.Array(Schema.String),
  /** More matched than are listed. */
  truncated: Schema.Boolean,
});

/** `AI.Grep` for Pi, which has no search tool of its own: `grep -rnE` in the sandbox. */
export const GrepLive = AI.Grep.make(
  {
    description: `Search file contents with a regular expression. Returns matching lines as path:line:text, at most ${MAX_LINES}. Narrow the search with path or include when there are more.`,
    parameters: Schema.Struct({
      pattern: Schema.String.annotate({ description: "Extended regular expression to search for" }),
      path: Schema.optional(
        Schema.String.annotate({ description: "File or directory to search (default: .)" }),
      ),
      include: Schema.optional(
        Schema.String.annotate({
          description: 'Only search files matching this glob, e.g. "*.ts"',
        }),
      ),
    }),
    success: Found,
    replay: "safe",
  },
  Effect.succeed(
    Effect.fn(function* ({ pattern, path, include }) {
      const sandbox = yield* Sandbox;
      const result = yield* sandbox
        .exec([
          "grep",
          "-rnE",
          "--exclude-dir=.git",
          "--exclude-dir=node_modules",
          ...(include === undefined ? [] : [`--include=${include}`]),
          "--",
          pattern,
          path ?? ".",
        ])
        .pipe(Effect.orDie);
      return lines(result.stdout);
    }),
  ),
);

/** `AI.Glob` for Pi, which has no file finder of its own: a `bash` glob in the sandbox. */
export const GlobLive = AI.Glob.make(
  {
    description: `Find files by glob pattern, such as "src/**/*.ts". Returns matching paths, at most ${MAX_LINES}.`,
    parameters: Schema.Struct({
      pattern: Schema.String.annotate({ description: "Glob pattern; ** matches any depth" }),
      path: Schema.optional(
        Schema.String.annotate({ description: "Directory to search from (default: .)" }),
      ),
    }),
    success: Found,
    replay: "safe",
  },
  Effect.succeed(
    Effect.fn(function* ({ pattern, path }) {
      const sandbox = yield* Sandbox;
      const result = yield* sandbox
        .exec([
          "bash",
          "-O",
          "globstar",
          "-O",
          "nullglob",
          "-c",
          // An empty IFS keeps a pattern with spaces whole while it still expands.
          'cd "$1" && IFS= && printf "%s\\n" $2',
          "glob",
          path ?? ".",
          pattern,
        ])
        .pipe(Effect.orDie);
      return lines(result.stdout);
    }),
  ),
);

/**
 * A Layer for every tool in `AI.CodingTools`: Pi's own `bash`, `read`,
 * `edit` and `write`, and a `grep` and `glob` that run in the sandbox.
 */
export const CodingToolsLive = Layer.mergeAll(
  BashLive,
  ReadLive,
  EditLive,
  WriteLive,
  GrepLive,
  GlobLive,
);
