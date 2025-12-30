import { Tool, Toolkit } from "@effect/ai";
import * as S from "effect/Schema";
import * as Path from "@effect/platform/Path";
import * as FileSystem from "@effect/platform/FileSystem";
import * as Effect from "effect/Effect";

export const write = Tool.make("write", {
  description: `Writes a file to the local filesystem.

Usage:
- This tool will overwrite the existing file if there is one at the provided path.
- If this is an existing file, you MUST use the Read tool first to read the file's contents. This tool will fail if you did not read the file first.
- ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required.
- NEVER proactively create documentation files (*.md) or README files. Only create documentation files if explicitly requested by the User.
- Only use emojis if the user explicitly requests it. Avoid writing emojis to files unless asked.
`,
  parameters: {
    filePath: S.String.annotations({
      description: "The path to the file to write",
    }),
    content: S.String.annotations({
      description: "The content to write to the file",
    }),
  },
  success: S.Void,
  failure: S.Any,
});

export const writeTooklit = Toolkit.make(write);

export const writeTooklitLayer = writeTooklit.toLayer(
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    return {
      write: Effect.fn(function* ({ filePath: _filePath, content }) {
        yield* Effect.log("write", { filePath: _filePath, content });
        const filePath = path.isAbsolute(_filePath)
          ? _filePath
          : path.join(process.cwd(), _filePath);
        yield* fs.writeFileString(filePath, content);
      }),
    };
  }),
);
