import { Tool, Toolkit } from "@effect/ai";
import * as Option from "effect/Option";
import * as S from "effect/Schema";
import * as Effect from "effect/Effect";
import * as FileSystem from "@effect/platform/FileSystem";
import * as Path from "@effect/platform/Path";
import * as Ripgrep from "../util/ripgrep.ts";
import { CommandExecutor } from "@effect/platform/CommandExecutor";

export const glob = Tool.make("glob", {
  description: `- Fast file pattern matching tool that works with any codebase size
- Supports glob patterns like "**/*.js" or "src/**/*.ts"
- Returns matching file paths sorted by modification time
- Use this tool when you need to find files by name patterns
- When you are doing an open-ended search that may require multiple rounds of globbing and grepping, use the Task tool instead
- You have the capability to call multiple tools in a single response. It is always better to speculatively perform multiple searches as a batch that are potentially useful.
`,
  dependencies: [CommandExecutor, FileSystem.FileSystem],
  parameters: {
    pattern: S.String.annotations({
      description: "The glob pattern to match files against",
    }),
    path: S.String.annotations({
      description: `The directory to search in. If not specified, the current working directory will be used. IMPORTANT: Omit this field to use the default directory. DO NOT enter "undefined" or "null" - simply omit it for the default behavior. Must be a valid directory path if provided.`,
    }),
  },
  success: S.String,
  failure: S.Any,
});

export const globTooklit = Toolkit.make(glob);

export const globTooklitLayer = globTooklit.toLayer(
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    return {
      glob: Effect.fn(function* (params) {
        yield* Effect.log("glob", params);
        let searchPath = params.path || process.cwd();
        searchPath = path.isAbsolute(searchPath)
          ? searchPath
          : path.resolve(process.cwd(), searchPath);
        const files: { path: string; mtime: number }[] = [];
        const limit = 100;
        let truncated = false;
        for (const filePath of yield* Ripgrep.findFiles({
          cwd: searchPath,
          glob: [params.pattern],
        })) {
          if (files.length >= limit) {
            truncated = true;
            break;
          }
          const stats = yield* fs.stat(filePath);
          if (!stats) continue;
          files.push({
            path: filePath,
            mtime: stats.mtime.pipe(Option.getOrUndefined)?.getTime() || 0,
          });
        }
        files.sort((a, b) => b.mtime - a.mtime);
        const output = files.map((f) => f.path);
        if (truncated) {
          return `${output.join("\n")}\n\n(${output.length} files found. Results are truncated, consider using a more specific pattern.)`;
        }
        return output.join("\n");
      }),
    };
  }),
);
