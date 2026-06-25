import * as AI from "alchemy/AI";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as S from "effect/Schema";
import { ReadTracker } from "../ReadTracker.ts";
import { Sandbox } from "../Sandbox.ts";

export const filePath = AI.Parameter("filePath", S.String)`
The path to the file to modify, relative to the workspace root.`;

export const oldString = AI.Parameter("oldString", S.String)`
The text to replace.`;

export const newString = AI.Parameter("newString", S.String)`
The text to replace it with (must be different from oldString).`;

export const replaceAll = AI.Parameter("replaceAll")(
  S.Boolean.pipe(S.optional),
)`Replace all occurrences of oldString (default false).`;

export class Edit extends AI.Tool<Edit>()("edit")`
Performs exact string replacements in files.

Usage:
- You must use the read tool at least once before editing ${filePath}. This tool
  will error if you attempt an edit without reading the file.
- When editing text from read tool output, ensure you preserve the exact
  indentation (tabs/spaces) as it appears AFTER the line number prefix. The line
  number prefix format is: line number + colon + space (e.g. \`1: \`). Everything
  after that space is the actual file content to match. Never include any part
  of the line number prefix in ${oldString} or ${newString}.
- ALWAYS prefer editing existing files in the codebase. NEVER write new files
  unless explicitly required.
- Only use emojis if the user explicitly requests it.
- The edit will FAIL if ${oldString} is not found in the file.
- The edit will FAIL if ${oldString} is found multiple times — provide a larger
  string with more surrounding context to make it unique, or use ${replaceAll}
  to change every instance.
- Use ${replaceAll} for replacing and renaming strings across the file.` {}

export const EditLive = Layer.effect(
  Edit,
  Effect.gen(function* () {
    const sandbox = yield* Sandbox;
    const tracker = yield* ReadTracker;

    return Effect.fn("edit")(function* (params) {
      const { filePath, oldString, newString, replaceAll } = params as {
        filePath: string;
        oldString: string;
        newString: string;
        replaceAll?: boolean;
      };

      if (oldString === newString) {
        return {
          error: "No changes to apply: oldString and newString are identical.",
        };
      }
      if (!(yield* tracker.hasRead(filePath))) {
        return {
          error: `You must read ${filePath} with the read tool before editing it.`,
        };
      }

      const current = yield* sandbox.readFile(filePath);
      const occurrences = current.split(oldString).length - 1;
      if (occurrences === 0) {
        return { error: "oldString not found in content" };
      }
      if (occurrences > 1 && !replaceAll) {
        return {
          error:
            "Found multiple matches for oldString. Provide more surrounding lines in oldString to identify the correct match, or set replaceAll to change every instance.",
        };
      }

      const { replacements } = yield* sandbox.editFile(
        filePath,
        oldString,
        newString,
        replaceAll,
      );
      return { path: filePath, replacements };
    });
  }),
);
