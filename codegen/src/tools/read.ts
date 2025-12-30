import { Tool, Toolkit } from "@effect/ai";

import * as S from "effect/Schema";
import * as Path from "@effect/platform/Path";
import * as FileSystem from "@effect/platform/FileSystem";
import * as Effect from "effect/Effect";

export const read = Tool.make("read", {
  description: `Reads a file from the local filesystem. You can access any file directly by using this tool.
Assume this tool is able to read all files on the machine. If the User provides a path to a file assume that path is valid. It is okay to read a file that does not exist; an error will be returned.

Usage:
- The filePath parameter must be an absolute path, not a relative path
- By default, it reads up to 2000 lines starting from the beginning of the file
- You can optionally specify a line offset and limit (especially handy for long files), but it's recommended to read the whole file by not providing these parameters
- Any lines longer than 2000 characters will be truncated
- Results are returned using cat -n format, with line numbers starting at 1
- You have the capability to call multiple tools in a single response. It is always better to speculatively read multiple files as a batch that are potentially useful.
- If you read a file that exists but has empty contents you will receive a system reminder warning in place of file contents.
- You can read image files using this tool.
`,
  parameters: {
    filePath: S.String.annotations({
      description: "The path to the file to read",
    }),
    offset: S.Number.annotations({
      description: "The line number to start reading from (0-based)",
    }),
    limit: S.Number.annotations({
      description: "The number of lines to read (defaults to 2000)",
    }),
  },
  success: S.String,
  failure: S.Any,
});

export const readTooklit = Toolkit.make(read);

export const readTooklitLayer = readTooklit.toLayer(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return {
      read: Effect.fn(function* ({
        filePath: _filePath,
        // offset = 0,
        // limit = 2000,
      }) {
        const offset = 0;
        const limit = 2000;
        yield* Effect.log("read", { filePath: _filePath });
        if (_filePath.includes(".env")) {
          return yield* Effect.fail("Environment variables are not readable");
        }
        const filePath = path.isAbsolute(_filePath)
          ? _filePath
          : path.join(process.cwd(), _filePath);

        if (yield* fs.exists(filePath)) {
          const dir = path.dirname(filePath);
          const base = path.basename(filePath);
          const files = yield* fs.readDirectory(dir);
          const suggestions = files
            .filter(
              (entry) =>
                entry.toLowerCase().includes(base.toLowerCase()) ||
                base.toLowerCase().includes(entry.toLowerCase()),
            )
            .map((entry) => path.join(dir, entry))
            .slice(0, 3);

          if (suggestions.length > 0) {
            return yield* Effect.fail(
              `File not found: ${filePath}. Did you mean one of these files? ${suggestions.join(", ")}`,
            );
          }
          return yield* Effect.fail(`File not found: ${filePath}`);
        }
        return (yield* fs.readFileString(filePath))
          .split("\n")
          .slice(offset, offset + limit)
          .join("\n");
      }),
    };
  }),
);
