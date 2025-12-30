import { Tool, Toolkit } from "@effect/ai";
import * as S from "effect/Schema";
import * as Path from "@effect/platform/Path";
import * as FileSystem from "@effect/platform/FileSystem";
import * as Effect from "effect/Effect";
import { replace } from "../util/replace.ts";

export const edit = Tool.make("edit", {
  description: `Performs exact string replacements in files. 

Usage:
- You must use your \`Read\` tool at least once in the conversation before editing. This tool will error if you attempt an edit without reading the file. 
- When editing text from Read tool output, ensure you preserve the exact indentation (tabs/spaces) as it appears AFTER the line number prefix. The line number prefix format is: spaces + line number + tab. Everything after that tab is the actual file content to match. Never include any part of the line number prefix in the oldString or newString.
- ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required.
- Only use emojis if the user explicitly requests it. Avoid adding emojis to files unless asked.
- The edit will FAIL if \`oldString\` is not found in the file with an error "oldString not found in content".
- The edit will FAIL if \`oldString\` is found multiple times in the file with an error "oldString found multiple times and requires more code context to uniquely identify the intended match". Either provide a larger string with more surrounding context to make it unique or use \`replaceAll\` to change every instance of \`oldString\`. 
- Use \`replaceAll\` for replacing and renaming strings across the file. This parameter is useful if you want to rename a variable for instance.
`,
  parameters: {
    filePath: S.String.annotations({
      description: "The absolute path to the file to modify",
    }),
    oldString: S.String.annotations({
      description: "The text to replace",
    }),
    newString: S.String.annotations({
      description:
        "The text to replace it with (must be different from oldString)",
    }),
    replaceAll: S.Boolean.annotations({
      description: "Replace all occurrences of oldString (default false)",
    }),
  },
  failure: S.Any,
});

export const editTooklit = Toolkit.make(edit);

export const editTooklitLayer = editTooklit.toLayer(
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;

    return {
      edit: Effect.fn(function* (params) {
        yield* Effect.log("edit", params);
        const {
          filePath: _filePath,
          oldString,
          newString,
          replaceAll,
        } = params;
        if (oldString === newString) {
          return yield* Effect.fail({
            error: "oldString and newString must be different",
          });
        }

        const filePath = path.isAbsolute(_filePath)
          ? _filePath
          : path.join(process.cwd(), _filePath);

        if (oldString === "") {
          yield* fs.writeFileString(filePath, newString);
        } else {
          const stat = yield* fs.stat(filePath).pipe(
            Effect.catchIf(
              (err) => err._tag === "SystemError" && err.reason === "NotFound",
              () => Effect.void,
            ),
          );
          if (!stat) {
            return yield* Effect.fail({
              error: `File not found: ${filePath}`,
            });
          }
          if (stat.type === "Directory") {
            return yield* Effect.fail({
              error: `Path is a directory, not a file: ${filePath}`,
            });
          }
          const oldContent = yield* fs.readFileString(filePath);
          const newContent = yield* replace(
            oldContent,
            oldString,
            newString,
            replaceAll,
          );
          yield* fs.writeFileString(filePath, newContent);
        }
      }),
    };
  }),
);
